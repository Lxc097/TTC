"""面试官后端入口。

跑起来：
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Demo 前切换数据源：
    VISION_PROVIDER=mock uvicorn main:app --port 8000
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
from api import router

BASE = Path(__file__).resolve().parent
CLASSIC_WEB = BASE.parent.parent / "frontend"
PERSONAL_WEB = BASE.parent.parent / "personal"

app = FastAPI(title="耳语 · 面试官后端", version="0.1")

# 前端同学可能在 5173 之类的端口起页面，全开省事
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)

_static = BASE / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

# 本地联调时两端同源；线上 nginx 仍把企业端放在站点根路径。
if CLASSIC_WEB.is_dir():
    app.mount("/classic", StaticFiles(directory=str(CLASSIC_WEB), html=True), name="classic")

# TTC 的真实面试候选人端；与 gerenduan/ 的模拟练习项目分开。
if PERSONAL_WEB.is_dir():
    app.mount("/personal", StaticFiles(directory=str(PERSONAL_WEB), html=True), name="personal")


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

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
