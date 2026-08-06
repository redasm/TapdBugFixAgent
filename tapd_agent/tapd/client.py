"""Tapd OpenAPI REST 客户端。

- 鉴权：HTTP Basic Auth（api_user / api_password，Tapd 个人设置 -> API账号 创建）
- 接口：GET /bugs（列表/详情）、POST /bugs（更新）、POST /bugs/add_comment（评论）
- 参考：https://open.tapd.cn/document/api
"""
from __future__ import annotations

import time
from typing import Any, Optional

import requests

from ..models import Bug

BASE_URL = "https://api.tapd.cn"
PAGE_SIZE = 200
RETRY_TIMES = 2
RETRY_BACKOFF = 2.0


class TapdError(RuntimeError):
    pass


class TapdClient:
    def __init__(self, api_user: str, api_password: str, workspace_id: str):
        self.session = requests.Session()
        self.session.auth = (api_user, api_password)
        self.workspace_id = str(workspace_id)
        self.session.headers.update({"User-Agent": "TapdBugFixAgent/0.1"})

    # ---------- 底层请求 ----------
    def _get(self, path: str, params: dict) -> dict:
        return self._request("GET", path, params=params)

    def _post(self, path: str, data: dict) -> dict:
        return self._request("POST", path, data=data)

    def _request(self, method: str, path: str, **kwargs: Any) -> dict:
        url = BASE_URL + path
        kwargs.setdefault("timeout", 30)
        last_err: Optional[Exception] = None
        for attempt in range(RETRY_TIMES + 1):
            try:
                resp = self.session.request(method, url, **kwargs)
                if resp.status_code in (429, 500, 502, 503, 504) and attempt < RETRY_TIMES:
                    time.sleep(RETRY_BACKOFF * (attempt + 1))
                    continue
                resp.raise_for_status()
                payload = resp.json()
                if payload.get("status") != 1:
                    raise TapdError(f"Tapd 返回异常状态: {payload}")
                return payload
            except (requests.RequestException, ValueError) as exc:
                last_err = exc
                if attempt < RETRY_TIMES:
                    time.sleep(RETRY_BACKOFF * (attempt + 1))
                    continue
        raise TapdError(f"Tapd 请求失败 {method} {path}: {last_err}") from last_err

    # ---------- 业务接口 ----------
    def list_bugs(self, **filters: Any) -> list[Bug]:
        """拉取全部匹配的 bug（自动翻页）。"""
        page = 1
        out: list[Bug] = []
        while True:
            params = {
                "workspace_id": self.workspace_id,
                "limit": PAGE_SIZE,
                "page": page,
                **filters,
            }
            payload = self._get("/bugs", params)
            items = payload.get("data") or []
            out.extend(Bug.from_dict(it, self.workspace_id) for it in items)
            if len(items) < PAGE_SIZE:
                break
            page += 1
        return out

    def get_bug(self, bug_id: int) -> Bug:
        payload = self._get("/bugs", {"workspace_id": self.workspace_id, "id": bug_id})
        data = payload.get("data")
        if isinstance(data, dict):
            return Bug.from_dict(data, self.workspace_id)
        return Bug.from_dict({"id": bug_id}, self.workspace_id)

    def update_bug(self, bug_id: int, **fields: Any) -> dict:
        """更新 bug 字段（如 status / current_owner）。"""
        data = {"workspace_id": self.workspace_id, "id": bug_id, **fields}
        return self._post("/bugs", data)

    def add_comment(self, bug_id: int, content: str) -> dict:
        return self._post(
            "/bugs/add_comment",
            {
                "workspace_id": self.workspace_id,
                "entry_type": "bug",
                "entry_id": bug_id,
                "content": content,
            },
        )
