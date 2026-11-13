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

BASE = Path(__file__).parent

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


@app.get("/")
def index() -> FileResponse:
    """自测页：不用等前端，直接看后端能不能跑。"""
    return FileResponse(str(_static / "dev_candidate.html"))


@app.get("/api/config")
def client_config() -> dict:
    """前端启动时拉一次，用于决定显示「建立基线中」还是「信号分析中」。"""
    return {
        "baseline_seconds": config.BASELINE_SECONDS,
        "probe_threshold": config.PROBE_THRESHOLD,
        "hint_cooldown": config.HINT_COOLDOWN,
        "vision_provider": config.VISION_PROVIDER,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
