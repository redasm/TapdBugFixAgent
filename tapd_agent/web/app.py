"""FastAPI 管理台：状态/控制/bug 列表与详情/SSE。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from ..config import Config
from ..state import StateStore
from ..worker import Worker

STATIC_DIR = Path(__file__).parent / "static"

_VALID_ACTIONS = {"start", "stop", "pause", "resume"}


class ControlAction(BaseModel):
    action: str


def create_app(config: Config, store: StateStore, worker: Worker) -> FastAPI:
    app = FastAPI(title="TapdBugFixAgent", version="0.1.0")
    token = config.web_token()

    async def auth(request: Request) -> None:
        if not token:
            return
        t = request.query_params.get("token") or ""
        authz = request.headers.get("Authorization") or ""
        if authz.startswith("Bearer "):
            t = authz[7:]
        if t != token:
            raise HTTPException(status_code=401, detail="未授权")

    @app.get("/")
    async def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/status", dependencies=[Depends(auth)])
    async def status():
        return worker.status()

    @app.post("/api/control", dependencies=[Depends(auth)])
    async def control(action: ControlAction):
        a = action.action
        if a not in _VALID_ACTIONS:
            raise HTTPException(status_code=400, detail=f"未知 action: {a}")
        return {"control": getattr(worker, a)()}

    @app.get("/api/bugs", dependencies=[Depends(auth)])
    async def list_bugs(
        state: str = Query(default="all"), q: str = Query(default="")
    ):
        # 返回 Tapd 实时 bug + 本地处理状态合并后的列表（含未处理）
        return {"items": worker.list_bugs_for_web()}

    @app.get("/api/bugs/{bug_id}", dependencies=[Depends(auth)])
    async def bug_detail(bug_id: int):
        detail = worker.bug_detail_for_web(bug_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="未找到该 bug")
        return detail

    @app.post("/api/bugs/{bug_id}/retry", dependencies=[Depends(auth)])
    async def retry(bug_id: int):
        if not worker.retry_bug(bug_id):
            raise HTTPException(status_code=404, detail="未找到该 bug")
        return {"ok": True}

    @app.post("/api/bugs/{bug_id}/skip", dependencies=[Depends(auth)])
    async def skip(bug_id: int):
        if not worker.skip_bug(bug_id):
            raise HTTPException(status_code=404, detail="未找到该 bug")
        return {"ok": True}

    @app.get("/api/events", dependencies=[Depends(auth)])
    async def events():
        async def gen():
            while True:
                payload = {
                    "status": worker.status(),
                    "items": worker.list_bugs_for_web(),
                }
                yield (
                    "event: snapshot\n"
                    f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                )
                await asyncio.sleep(2)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
