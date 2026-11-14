"""面试官后端入口。

跑起来：
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000

Demo 前切换数据源：
    VISION_PROVIDER=mock uvicorn app:app --port 8000
"""
from __future__ import annotations

from pathlib import Path
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from shared import config
from interviewer.api import router
from candidate.recruitment_api import router as recruitment_router, start_worker, stop_worker
from candidate.formal_interview_api import router as formal_interview_router

BASE = Path(__file__).resolve().parent
CLASSIC_WEB = BASE.parent / "frontend" / "interviewer"
PERSONAL_WEB = BASE.parent / "frontend" / "candidate"
AI_WEB = BASE.parent / "ai-interview" / "dist"


class InterviewSPAFiles(StaticFiles):
    """Serve the built React entry on document-route refresh, not missing assets."""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or "." in Path(path).name or path.startswith("assets/"):
                raise
            return await super().get_response("index.html", scope)

app = FastAPI(title="耳语 · 面试官后端", version="0.1")


@app.middleware("http")
async def private_response_headers(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/api/applications":
        try:
            declared_size = int(request.headers.get("content-length", "0"))
        except ValueError:
            declared_size = 0
        if declared_size > 8 * 1024 * 1024 + 128 * 1024:
            return JSONResponse(status_code=413, content={"detail": "简历文件不能超过 8 MB。"},
                                headers={"Cache-Control": "no-store",
                                         "X-Content-Type-Options": "nosniff",
                                         "Referrer-Policy": "no-referrer"})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith(("/api/auth", "/api/applications", "/api/hr", "/api/interview")):
        response.headers["Cache-Control"] = "no-store"
    return response

# Same-origin pages need no CORS. Explicit local dev origins preserve split-port
# workflows without exposing authenticated recruitment responses to every site.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("TTC_CORS_ORIGINS",
        "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5500,"
        "http://localhost:5500,http://127.0.0.1:8080,http://localhost:8080").split(",")
        if origin.strip()],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(router)
app.include_router(recruitment_router)
app.include_router(formal_interview_router)


@app.on_event("startup")
async def start_recruitment_worker() -> None:
    await start_worker()


@app.on_event("shutdown")
async def stop_recruitment_worker() -> None:
    await stop_worker()

_static = BASE / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

# 本地联调时两端同源；线上 nginx 仍把企业端放在站点根路径。
if CLASSIC_WEB.is_dir():
    app.mount("/classic", StaticFiles(directory=str(CLASSIC_WEB), html=True), name="classic")

# TTC 的真实面试候选人端；与 ai-interview/ 的模拟练习项目分开。
if PERSONAL_WEB.is_dir():
    app.mount("/personal", StaticFiles(directory=str(PERSONAL_WEB), html=True), name="personal")

# Built autonomous voice interview UI. Build ai-interview first; API requests stay
# same-origin and are authenticated/proxied to the loopback-only Node sidecar.
if AI_WEB.is_dir():
    app.mount("/ai-interview", InterviewSPAFiles(directory=str(AI_WEB), html=True), name="ai-interview")


@app.get("/")
def index() -> FileResponse:
    """自测页：不用等前端，直接看后端能不能跑。"""
    return FileResponse(str(_static / "dev_candidate.html"))


@app.get("/recorder")
def recorder() -> FileResponse:
    """候选人侧录制参考实现：每 30 秒切一段视频，走 video_chunk。"""
    return FileResponse(str(_static / "dev_recorder.html"))


@app.get("/api/config")
def client_config() -> dict:
    """前端启动时拉一次，用于决定显示「建立基线中」还是「信号分析中」。"""
    return {
        "baseline_seconds": config.BASELINE_SECONDS,
        "probe_threshold": config.PROBE_THRESHOLD,
        "hint_cooldown": config.HINT_COOLDOWN,
        "vision_provider": config.VISION_PROVIDER,
        # 前端据此决定：能不能开语音转写，还是只能用键盘手打
        "stt_enabled": config.STT_ENABLED and bool(config.STT_API_KEY),
        "stt_model": config.STT_MODEL,
        "llm_enabled": config.LLM_ENABLED,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
