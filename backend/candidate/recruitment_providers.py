"""Server-side SiliconFlow and UAPI provider adapters for recruitment."""
from __future__ import annotations

import json
import os
import ipaddress
import re
import copy
import threading
import time
import weakref
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

from shared import config as recruitment_config
from .recruitment_provider_limiter import SharedProviderLimit

_search_lock = threading.Lock()
_search_cache: dict[tuple, tuple[float, dict]] = {}
_search_locks = weakref.WeakValueDictionary()
_markdown_cache: dict[str, tuple[float, dict]] = {}
_markdown_locks = weakref.WeakValueDictionary()
_search_limit = SharedProviderLimit("search", recruitment_config.SEARCH_MAX_CONCURRENCY)
_ai_limit = SharedProviderLimit("ai", recruitment_config.AI_MAX_CONCURRENCY)


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None,
                 retryable: bool = False, trace_id: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.trace_id = trace_id


def _http_json(url: str, *, api_key: str = "", body: dict | None = None,
               timeout: float = 30, trace_id: str | None = None) -> tuple[dict, dict]:
    headers = {"Accept": "application/json", "User-Agent": "TTC-Recruitment/1"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    if trace_id:
        headers["X-Trace-Id"] = trace_id
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers=headers,
                                     method="POST" if body is not None else "GET")
    for attempt in range(2):
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise ProviderError("供应商响应过大。")
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ProviderError("供应商返回的 JSON 结构无效。")
                return payload, {
                    "elapsedMs": round((time.monotonic() - started) * 1000),
                    "traceId": response.headers.get("X-Request-ID")
                               or response.headers.get("x-siliconcloud-trace-id") or trace_id,
                }
        except urllib.error.HTTPError as exc:
            status = exc.code
            retryable = status in (408, 429, 500, 502, 503, 504)
            request_id = exc.headers.get("X-Request-ID") or exc.headers.get("x-siliconcloud-trace-id") or trace_id
            if retryable and attempt == 0:
                retry_after = exc.headers.get("Retry-After")
                try:
                    delay = min(2.0, max(0.0, float(retry_after))) if retry_after else 0.5
                except ValueError:
                    delay = 0.5
                time.sleep(delay)
                continue
            raise ProviderError(f"供应商请求失败（HTTP {status}）。", status_code=status,
                                retryable=retryable, trace_id=request_id) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 0:
                time.sleep(0.5)
                continue
            raise ProviderError("供应商网络请求失败或超时。", retryable=True, trace_id=trace_id) from None
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ProviderError("供应商返回的 JSON 无效。", trace_id=trace_id) from None
    raise ProviderError("供应商请求失败。", retryable=True, trace_id=trace_id)


class SiliconFlowProvider:
    """OpenAI-compatible JSON calls with model-specific reasoning options."""

    def __init__(self, *, api_key: str | None = None, base_url: str | None = None,
                 model: str | None = None, timeout: float | None = None):
        self.api_key = (api_key if api_key is not None else os.getenv("SILICONFLOW_API_KEY", "")).strip()
        self.base_url = (base_url or os.getenv("SILICONFLOW_BASE_URL")
                         or "https://api.siliconflow.cn/v1").rstrip("/")
        self.model = model or recruitment_config.RECRUITMENT_AI_MODEL
        self.fast_model = os.getenv("SILICONFLOW_MODEL_FAST") or recruitment_config.RECRUITMENT_AI_MODEL
        self.timeout = timeout or float(os.getenv("AI_REQUEST_TIMEOUT", "90"))

    def list_models(self) -> list[str]:
        if not self.api_key:
            raise ProviderError("未配置 SILICONFLOW_API_KEY。")
        payload, _ = _http_json(self.base_url + "/models?sub_type=chat",
                                api_key=self.api_key, timeout=self.timeout)
        data = payload.get("data")
        if not isinstance(data, list):
            raise ProviderError("模型列表响应缺少 data。")
        return [item["id"] for item in data if isinstance(item, dict)
                and isinstance(item.get("id"), str)]

    def chat_json(self, system_prompt: str, user_payload: object, *, model: str | None = None,
                  reasoning_effort: str = "high", max_tokens: int = 4096) -> tuple[dict, dict]:
        if not self.api_key:
            raise ProviderError("未配置 SILICONFLOW_API_KEY。")
        selected = model or self.model
        user_text = user_payload if isinstance(user_payload, str) else json.dumps(user_payload, ensure_ascii=False)
        body = {"model": selected, "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text}],
            "stream": False, "max_tokens": max(128, min(8192, max_tokens)),
            "response_format": {"type": "json_object"}}
        if selected in {"Pro/deepseek-ai/DeepSeek-V4", "deepseek-ai/DeepSeek-V4-Flash"}:
            body["reasoning_effort"] = "max" if reasoning_effort == "max" else "high"
        trace_id = uuid.uuid4().hex
        # This semaphore is process-wide: concurrent applications and claims
        # share one RPM/TPM budget instead of each creating its own burst.
        with _ai_limit:
            payload, metadata = _http_json(self.base_url + "/chat/completions",
                                            api_key=self.api_key, body=body,
                                            timeout=self.timeout, trace_id=trace_id)
        try:
            parsed = json.loads(payload["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise ProviderError("模型未返回有效的 JSON 对象。", trace_id=metadata["traceId"]) from exc
        if not isinstance(parsed, dict):
            raise ProviderError("模型未返回 JSON 对象。", trace_id=metadata["traceId"])
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return parsed, {**metadata, "model": payload.get("model") or selected,
                        "promptTokens": usage.get("prompt_tokens"),
                        "completionTokens": usage.get("completion_tokens"),
                        "totalTokens": usage.get("total_tokens")}


class UAPISearchProvider:
    """UAPI public search; visitor mode works, production should supply a key."""

    def __init__(self, *, api_key: str | None = None, base_url: str | None = None,
                 timeout: float | None = None):
        self.api_key = (api_key if api_key is not None else os.getenv("UAPI_API_KEY", "")).strip()
        self.base_url = (base_url or os.getenv("UAPI_BASE_URL") or "https://uapis.cn").rstrip("/")
        self.timeout = timeout or float(os.getenv("AI_REQUEST_TIMEOUT", "30"))

    def search(self, query: str, *, site: str | None = None, filetype: str | None = None,
               fetch_full: bool = False, sort: str = "relevance",
               time_range: str | None = None) -> dict:
        query = query.strip()
        if not query or len(query) > 300:
            raise ValueError("搜索词须为 1–300 字。")
        if re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)", query):
            raise ValueError("搜索词包含个人联系方式或证件号，请仅使用必要的公开信息。")
        if sort not in ("relevance", "date") or time_range not in (None, "day", "week", "month", "year"):
            raise ValueError("搜索排序或时间范围无效。")
        body = {"query": query, "sort": sort, "fetch_full": fetch_full}
        if site:
            body["site"] = site
        if filetype:
            body["filetype"] = filetype
        if time_range:
            body["time_range"] = time_range
        cache_key = (self.base_url, bool(self.api_key), query, site, filetype, fetch_full, sort, time_range)
        ttl = max(0, min(86400, int(os.getenv("SEARCH_CACHE_TTL", "21600"))))
        with _search_lock:
            lock = _search_locks.setdefault(cache_key, threading.Lock())
        # A second identical query waits for the first result, rather than
        # making another paid request while the cache is still empty.
        with lock:
            with _search_lock:
                cached = _search_cache.get(cache_key)
                if cached and time.monotonic() - cached[0] < ttl:
                    result = copy.deepcopy(cached[1])
                    result["requestMeta"] = {**result["requestMeta"], "cacheHit": True}
                    return result
            with _search_limit:
                payload, metadata = _http_json(self.base_url + "/api/v1/search/aggregate",
                                                api_key=self.api_key, body=body, timeout=self.timeout)
            if not isinstance(payload.get("results"), list):
                raise ProviderError("搜索响应缺少 results。", trace_id=metadata["traceId"])
            results = []
            seen = set()
            for item in payload["results"]:
                if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                    continue
                url = item["url"]
                if not url.startswith(("https://", "http://")) or url in seen:
                    continue
                seen.add(url)
                results.append({"url": url, "title": str(item.get("title") or ""),
                                "snippet": str(item.get("snippet") or ""),
                                "domain": str(item.get("domain") or ""),
                                "publishedAt": item.get("publish_time"),
                                "source": item.get("source"), "position": item.get("position"),
                                "fullContent": item.get("content") or item.get("full_content")})
            normalized = {"query": query, "retrievedAt": datetime.now(timezone.utc).isoformat(),
                          "results": results, "totalResults": payload.get("total_results"),
                          "sources": payload.get("sources") if isinstance(payload.get("sources"), list) else [],
                          "requestMeta": {**metadata, "cacheHit": False},
                          "authMode": "api_key" if self.api_key else "visitor"}
            if ttl:
                with _search_lock:
                    if len(_search_cache) >= 200:
                        _search_cache.pop(next(iter(_search_cache)))
                    _search_cache[cache_key] = (time.monotonic(), copy.deepcopy(normalized))
            return normalized

    def fetch_markdown(self, url: str, *, max_wait_seconds: float = 65.0) -> dict:
        ttl = max(0, min(86400, int(os.getenv("SEARCH_CACHE_TTL", "21600"))))
        with _search_lock:
            lock = _markdown_locks.setdefault(url, threading.Lock())
        # Distinct URLs proceed in parallel; identical URLs share one request.
        with lock:
            with _search_lock:
                cached = _markdown_cache.get(url)
                if cached and time.monotonic() - cached[0] < ttl:
                    result = copy.deepcopy(cached[1])
                    result["requestMeta"] = {**result["requestMeta"], "cacheHit": True}
                    return result
            with _search_limit:
                result = self._fetch_markdown_uncached(url, max_wait_seconds=max_wait_seconds)
            if ttl:
                with _search_lock:
                    if len(_markdown_cache) >= 200:
                        _markdown_cache.pop(next(iter(_markdown_cache)))
                    _markdown_cache[url] = (time.monotonic(), copy.deepcopy(result))
            result["requestMeta"] = {**result["requestMeta"], "cacheHit": False}
            return result

    def _fetch_markdown_uncached(self, url: str, *, max_wait_seconds: float = 65.0) -> dict:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or len(url) > 2000:
            raise ValueError("网页 URL 无效。")
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            address = None
        if parsed.username or parsed.password or (address is not None and not address.is_global):
            raise ValueError("不允许转换私有或带凭据的网页地址。")
        # The live endpoint requires url in the query string (its JSON example is
        # not accepted as of 2026-11-14); an empty body keeps the method POST.
        submit_url = (self.base_url + "/api/v1/web/tomarkdown/async?" +
                      urllib.parse.urlencode({"url": url}))
        payload, metadata = _http_json(submit_url, api_key=self.api_key,
                                        body={}, timeout=self.timeout)
        task_id = payload.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            raise ProviderError("网页转换接口未返回 task_id。", trace_id=metadata["traceId"])
        deadline = time.monotonic() + max_wait_seconds
        while time.monotonic() < deadline:
            time.sleep(2.0)
            state, poll_meta = _http_json(
                self.base_url + "/api/v1/web/tomarkdown/async/" + urllib.parse.quote(task_id, safe=""),
                api_key=self.api_key, timeout=self.timeout)
            status = state.get("status")
            if status == "completed":
                result = state.get("result")
                markdown = result.get("markdown") if isinstance(result, dict) else None
                if not isinstance(markdown, str):
                    raise ProviderError("网页转换完成但缺少正文。", trace_id=poll_meta["traceId"])
                return {"url": url, "markdown": markdown, "taskId": task_id,
                        "retrievedAt": datetime.now(timezone.utc).isoformat(),
                        "requestMeta": poll_meta}
            if status in ("failed", "timeout"):
                raise ProviderError("网页正文获取失败。", retryable=True, trace_id=poll_meta["traceId"])
        raise ProviderError("网页正文获取超时。", retryable=True, trace_id=metadata["traceId"])
