"""HR-only natural-language hiring requirements consultant."""
from __future__ import annotations

import asyncio
import json
import re
import time
import urllib.error
import urllib.request
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError, model_validator

from . import recruitment_architect_store as store
from . import recruitment_store as repo
from .recruitment_api import hr
from .recruitment_providers import ProviderError, SiliconFlowProvider, _ai_limit
from .recruitment_skill_registry import requirement_prompt

router = APIRouter()


class HiringProfile(BaseModel):
    jobName: str = Field(min_length=2, max_length=120)
    recruitmentType: str = Field(pattern="^(campus|social|mixed)$")
    summary: str = Field(min_length=30, max_length=12_000)
    businessContext: str = Field(default="", max_length=2000)
    responsibilities: list[str] = Field(default_factory=list, max_length=20)
    expectedOutcomes: list[str] = Field(default_factory=list, max_length=20)
    requiredCapabilities: list[str] = Field(default_factory=list, max_length=20)
    trainableCapabilities: list[str] = Field(default_factory=list, max_length=20)
    bonusCapabilities: list[str] = Field(default_factory=list, max_length=20)
    hardConstraints: list[str] = Field(default_factory=list, max_length=12)
    alternativeExperience: list[str] = Field(default_factory=list, max_length=12)
    capabilityWeights: dict[str, int] = Field(default_factory=dict)
    resumeEvidence: list[str] = Field(default_factory=list, max_length=20)
    publicVerificationTargets: list[str] = Field(default_factory=list, max_length=20)
    interviewVerification: list[str] = Field(default_factory=list, max_length=20)
    unresolvedConditions: list[str] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def validate_weights(self):
        if not self.responsibilities or not self.expectedOutcomes or not self.requiredCapabilities:
            raise ValueError("草案须至少包含职责、预期成果和必备能力。")
        if any(re.search(r"性别|年龄|民族|婚育|已婚|未婚|外貌|gender|ethnicity|marital status",
                         item, re.IGNORECASE) for item in self.hardConstraints):
            raise ValueError("硬性条件不能包含与岗位能力无关的个人属性。")
        if any(weight < 0 or weight > 100 for weight in self.capabilityWeights.values()):
            raise ValueError("能力权重须在 0–100 之间。")
        if self.capabilityWeights and sum(self.capabilityWeights.values()) != 100:
            raise ValueError("能力权重总和须为 100。")
        for field in ("responsibilities", "expectedOutcomes", "requiredCapabilities",
                      "trainableCapabilities", "bonusCapabilities", "hardConstraints",
                      "alternativeExperience", "resumeEvidence", "publicVerificationTargets",
                      "interviewVerification", "unresolvedConditions"):
            values = getattr(self, field)
            if any(not isinstance(value, str) or not value.strip() or len(value) > 500
                   for value in values):
                raise ValueError(f"{field} 包含无效条目。")
        return self


class SessionBody(BaseModel):
    jobId: str | None = Field(default=None, max_length=80)


class MessageBody(BaseModel):
    message: str = Field(min_length=2, max_length=4000)


class StreamingMessageBody(MessageBody):
    retryMessageId: str | None = Field(default=None, max_length=80)


class ConfirmBody(BaseModel):
    profile: HiringProfile | None = None


@router.post("/api/hr/architect/sessions", status_code=201)
def create_session(body: SessionBody, user: dict = Depends(hr)) -> dict:
    session = store.create_session(user["companyId"], user["id"], body.jobId)
    if session is None:
        raise HTTPException(404, "岗位不存在或不属于当前企业。")
    return session


@router.get("/api/hr/architect/sessions")
def list_sessions(jobId: str | None = None, limit: int = Query(50, ge=1, le=100),
                  offset: int = Query(0, ge=0), user: dict = Depends(hr)) -> dict:
    items, total = store.list_sessions(user["companyId"], job_id=jobId, limit=limit, offset=offset)
    return {"items": items, "total": total}


@router.get("/api/hr/architect/sessions/{session_id}")
def get_session(session_id: str, user: dict = Depends(hr)) -> dict:
    session = store.get_session(session_id, user["companyId"])
    if session is None:
        raise HTTPException(404, "对话不存在。")
    return session


def _validated_answer(raw: dict) -> tuple[str, str, dict | None]:
    reply, stage = raw.get("reply"), raw.get("stage")
    if (not isinstance(reply, str) or not reply.strip() or len(reply) > 4000
            or stage not in ("clarifying", "draft")):
        raise ValueError("顾问返回格式无效，请重试。")
    profile = None
    if raw.get("profile") is not None:
        try:
            profile = HiringProfile.model_validate(raw["profile"]).model_dump()
        except ValidationError as exc:
            raise ValueError("顾问返回的岗位标准不符合结构要求，请重试。") from exc
    if stage == "draft" and profile is None:
        raise ValueError("顾问尚未生成有效的岗位标准，请重试。")
    return reply.strip(), stage, profile


def _reply_so_far(raw_json: str) -> str:
    """Decode only the reply string from an unfinished streamed JSON object."""
    match = re.search(r'"reply"\s*:\s*"', raw_json)
    if not match:
        return ""
    parts = []
    escaped = False
    for char in raw_json[match.end():]:
        if escaped:
            parts.append(char)
            escaped = False
        elif char == "\\":
            parts.append(char)
            escaped = True
        elif char == '"':
            break
        else:
            parts.append(char)
    value = "".join(parts)
    while value:
        try:
            return json.loads('"' + value + '"')
        except json.JSONDecodeError:
            value = value[:-1]
    return ""


def _model_stream(provider: SiliconFlowProvider, prompt: str, payload: dict):
    """Yield real SiliconFlow token deltas and one validated JSON result."""
    if not provider.api_key:
        raise ProviderError("未配置 SILICONFLOW_API_KEY。")
    trace_id = uuid.uuid4().hex
    body = {"model": provider.model,
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            "stream": True, "max_tokens": 4500,
            "response_format": {"type": "json_object"}}
    request = urllib.request.Request(provider.base_url + "/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + provider.api_key,
                 "Content-Type": "application/json", "Accept": "text/event-stream",
                 "X-Trace-Id": trace_id})
    started = time.monotonic()
    fragments: list[str] = []
    request_id = trace_id
    usage = {}
    try:
        with _ai_limit.lease():
            with urllib.request.urlopen(request, timeout=provider.timeout) as response:
                request_id = response.headers.get("X-Request-ID") or trace_id
                for line in response:
                    if not line.startswith(b"data:"):
                        continue
                    data = line[5:].strip()
                    if data == b"[DONE]":
                        break
                    if not data:
                        continue
                    chunk = json.loads(data.decode("utf-8"))
                    if isinstance(chunk.get("usage"), dict):
                        usage = chunk["usage"]
                    choices = chunk.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    delta = choices[0].get("delta")
                    content = delta.get("content") if isinstance(delta, dict) else None
                    if isinstance(content, str) and content:
                        fragments.append(content)
                        if sum(map(len, fragments)) > 100_000:
                            raise ProviderError("顾问模型响应过长。", trace_id=request_id)
                        yield {"content": "".join(fragments)}
    except urllib.error.HTTPError as exc:
        raise ProviderError(f"顾问模型请求失败（HTTP {exc.code}）。", status_code=exc.code,
                            retryable=exc.code in (408, 429, 500, 502, 503, 504),
                            trace_id=exc.headers.get("X-Request-ID") or request_id) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ProviderError("顾问模型网络请求失败或超时。", retryable=True, trace_id=request_id) from None
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProviderError("顾问模型返回的流式 JSON 无效。", trace_id=request_id) from exc
    try:
        raw = json.loads("".join(fragments))
    except json.JSONDecodeError as exc:
        raise ProviderError("顾问模型未返回完整 JSON。", trace_id=request_id) from exc
    if not isinstance(raw, dict):
        raise ProviderError("顾问模型未返回 JSON 对象。", trace_id=request_id)
    yield {"raw": raw, "usage": {"model": provider.model,
        "promptTokens": usage.get("prompt_tokens"),
        "completionTokens": usage.get("completion_tokens"),
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "traceId": request_id}}


def _event(kind: str, data: dict) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/api/hr/architect/sessions/{session_id}/messages/stream")
def stream_message(session_id: str, body: StreamingMessageBody,
                   user: dict = Depends(hr)) -> StreamingResponse:
    session = store.get_session(session_id, user["companyId"])
    if session is None:
        raise HTTPException(404, "对话不存在。")
    message = body.message.strip()
    try:
        pending = store.begin_exchange(session_id, user["companyId"], len(session["messages"]),
                                       message, retry_message_id=body.retryMessageId)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if pending is None:
        raise HTTPException(409, "对话状态已变化，请刷新后重试。")
    job = repo.get_job(session["jobId"]) if session["jobId"] else None
    prior = store.latest_profile(session["jobId"], user["companyId"]) if session["jobId"] else None
    context = " ".join([message, job["title"] if job else "",
                        job["description"] if job else ""])
    history = session["messages"][:-1] if body.retryMessageId else session["messages"]
    payload = {"job": {"title": job["title"], "description": job["description"]} if job else None,
               "messages": [{"role": item["role"], "content": item["content"]}
                            for item in history[-20:]],
               "draftProfile": session["draftProfile"],
               "latestConfirmedProfile": prior["profile"] if prior else None,
               "latestInput": message}

    def events():
        yield _event("started", {"messageId": pending["messageId"]})
        sent = ""
        try:
            for update in _model_stream(SiliconFlowProvider(), requirement_prompt(context), payload):
                if "content" in update:
                    reply = _reply_so_far(update["content"])
                    if reply.startswith(sent) and len(reply) > len(sent):
                        yield _event("delta", {"text": reply[len(sent):]})
                        sent = reply
                    continue
                reply, stage, profile = _validated_answer(update["raw"])
                if reply.startswith(sent) and len(reply) > len(sent):
                    yield _event("delta", {"text": reply[len(sent):]})
                saved = store.complete_exchange(session_id, user["companyId"], pending["messageId"],
                                                reply, profile, stage, update["usage"])
                if saved is None:
                    raise ValueError("对话状态已变化，请刷新后重试。")
                yield _event("completed", {"session": saved, "usage": update["usage"]})
                return
            raise ValueError("顾问模型没有返回完整结果。")
        except (ProviderError, ValueError, TypeError, KeyError) as exc:
            error = str(exc)[:180]
            store.fail_exchange(session_id, user["companyId"], pending["messageId"], error)
            yield _event("error", {"message": error, "messageId": pending["messageId"]})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/api/hr/architect/sessions/{session_id}/messages")
async def send_message(session_id: str, body: MessageBody, user: dict = Depends(hr)) -> dict:
    session = store.get_session(session_id, user["companyId"])
    if session is None:
        raise HTTPException(404, "对话不存在。")
    job = repo.get_job(session["jobId"]) if session["jobId"] else None
    prior = store.latest_profile(session["jobId"], user["companyId"]) if session["jobId"] else None
    message = body.message.strip()
    context = " ".join([message, job["title"] if job else "",
                        job["description"] if job else ""])
    payload = {"job": {"title": job["title"], "description": job["description"]} if job else None,
               "messages": [{"role": item["role"], "content": item["content"]}
                            for item in session["messages"][-20:]],
               "draftProfile": session["draftProfile"],
               "latestConfirmedProfile": prior["profile"] if prior else None,
               "latestInput": message}
    try:
        raw, usage = await asyncio.to_thread(
            SiliconFlowProvider().chat_json, requirement_prompt(context), payload,
            reasoning_effort="high", max_tokens=4500)
    except ProviderError as exc:
        raise HTTPException(503, str(exc), headers={"X-Trace-ID": exc.trace_id or ""}) from exc
    reply, stage = raw.get("reply"), raw.get("stage")
    if not isinstance(reply, str) or not reply.strip() or len(reply) > 4000 \
            or stage not in ("clarifying", "draft"):
        raise HTTPException(502, "顾问返回格式无效，请重试。")
    profile = None
    if raw.get("profile") is not None:
        try:
            profile = HiringProfile.model_validate(raw["profile"]).model_dump()
        except ValidationError as exc:
            raise HTTPException(502, "顾问返回的岗位标准不符合结构要求，请重试。") from exc
    if stage == "draft" and profile is None:
        raise HTTPException(502, "顾问尚未生成有效的岗位标准，请重试。")
    try:
        updated = store.add_exchange(session_id, user["companyId"], len(session["messages"]),
                                     message, reply.strip(), profile, stage, usage)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if updated is None:
        raise HTTPException(409, "对话状态已变化，请刷新后重试。")
    updated["usage"] = usage
    return updated


@router.post("/api/hr/architect/sessions/{session_id}/confirm")
def confirm(session_id: str, body: ConfirmBody, user: dict = Depends(hr)) -> dict:
    session = store.get_session(session_id, user["companyId"])
    if session is None:
        raise HTTPException(404, "对话不存在。")
    if session["stage"] == "confirmed":
        return session
    chosen = body.profile.model_dump() if body.profile else session["draftProfile"]
    if chosen is None or session["stage"] != "draft":
        raise HTTPException(409, "请先完成招聘需求澄清并查看草案。")
    try:
        profile = HiringProfile.model_validate(chosen).model_dump()
    except ValidationError as exc:
        raise HTTPException(422, "岗位标准格式无效。") from exc
    return store.confirm_session(session_id, user["companyId"], user["id"], profile)


@router.get("/api/hr/jobs/{job_id}/profile")
def job_profile(job_id: str, user: dict = Depends(hr)) -> dict:
    profile = store.latest_profile(job_id, user["companyId"])
    if profile is None:
        raise HTTPException(404, "该岗位尚无已确认标准。")
    return profile


@router.get("/api/hr/jobs/{job_id}/profiles")
def job_profile_versions(job_id: str, user: dict = Depends(hr)) -> dict:
    items = store.list_profiles(job_id, user["companyId"])
    if items is None:
        raise HTTPException(404, "岗位不存在或不属于当前企业。")
    return {"items": items}


@router.get("/api/hr/jobs/{job_id}/profiles/{version}")
def job_profile_version(job_id: str, version: int, user: dict = Depends(hr)) -> dict:
    if version < 1:
        raise HTTPException(404, "招聘标准版本不存在。")
    saved = store.get_profile_version(job_id, user["companyId"], version)
    if saved is None:
        raise HTTPException(404, "招聘标准版本不存在。")
    return saved
