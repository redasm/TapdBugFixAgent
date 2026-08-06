"""Tapd MCP 客户端：通过 MCP 协议调用「腾讯云 TAPD MCP Server」。

解决点：个人访问令牌（TAPD_ACCESS_TOKEN）比 API 账号（公司级 API账号管理）好申请，
不需要公司管理员开权限。

两种传输：
- streamable-http：url 填腾讯云托管 MCP 的专属连接地址（tapd.mcp.url），可选 token
- stdio：本地启动服务端（command+args，如 uvx mcp-server-tapd 或 npx -y @xihe-lab/tapd-mcp-server），
  通过 env 传入 TAPD_ACCESS_TOKEN

设计：连接后运行时 list_tools() 自动发现工具，按名称/描述匹配到本客户端的
四个操作（list_bugs / get_bug / update_bug / add_comment），参数按 schema 过滤。
工具名若与默认匹配不一致，可在 config.yaml tapd.mcp.tool_map 显式覆盖。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
from typing import Any, Optional

from ..models import Bug
from .client import TapdError

_BUG_HINTS = ("bug", "defect", "缺陷", "bugtrace", "bug_trace")

# 已确认的官方 mcp-server-tapd / @xihe-lab/tapd-mcp-server 工具名（可被 config 覆盖）
_DEFAULT_TOOL_MAP = {
    "list_bugs": "tapd_get_bugs",
    "get_bug": "tapd_get_bugs",      # 传 id 取单个
    "update_bug": "tapd_update_bug",
    "add_comment": "tapd_create_comment",  # 注意内容参数是 description
}

# 每个操作需要命中的"动作动词"（名称或描述包含其一即可加分）
_OP_VERBS = {
    "list_bugs": ("list", "query", "search", "get", "view",
                  "获取", "查询", "列表", "我的", "拉取"),
    "get_bug": ("get", "detail", "info", "find", "获取", "详情", "查询", "查找"),
    "update_bug": ("update", "edit", "modify", "change", "set", "更新", "修改", "编辑", "变更"),
    "add_comment": ("add", "create", "comment", "新增", "添加", "评论", "创建"),
}

_TOOL_MAP_KEYS = ("list_bugs", "get_bug", "update_bug", "add_comment")


def _lower(text: Any) -> str:
    return str(text or "").lower()


def _match_tool(tools: dict[str, Any], op: str) -> Optional[str]:
    """在已发现工具里按名称/描述为操作挑选最合适的工具名（启发式兜底）。"""
    exact = [n for n in tools if n == op or n.endswith(op) or op.endswith(n)]
    if exact:
        return sorted(exact, key=len)[0]

    verbs = _OP_VERBS.get(op, ())
    need_comment = op == "add_comment"
    best_name, best_score = None, 0
    for name, tool in tools.items():
        desc = _lower(getattr(tool, "description", "") or tool.get("description", ""))
        hay = _lower(name) + " " + desc
        if op != "add_comment" and not any(h in hay for h in _BUG_HINTS):
            continue
        if need_comment and "comment" not in hay and "评论" not in hay:
            continue
        if op in ("list_bugs", "get_bug") and "count" in name:
            continue  # 排除 count 类工具
        score = sum(1 for v in verbs if v in hay)
        # 参数加分：列表类工具通常带 limit/page/current_owner
        schema = getattr(tool, "input_schema", None)
        if schema is None and isinstance(tool, dict):
            schema = tool.get("input_schema")
        props = (schema or {}).get("properties") if isinstance(schema, dict) else None
        if isinstance(props, dict):
            if "limit" in props and "page" in props:
                score += 2
            if "current_owner" in props:
                score += 1
        if score > best_score:
            best_score, best_name = score, name
    return best_name if best_score > 0 else None


def _safe_get(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
        else:
            val = getattr(obj, name, None)
            if val is not None:
                return val
    return default


def _unwrap(value: Any) -> Any:
    """处理 mcp2 的 structured_content={'result': <值>} 包装，并尝试把 JSON 字符串解析为对象。"""
    if isinstance(value, dict) and set(value.keys()) <= {"result"}:
        value = value.get("result")
    if isinstance(value, str):
        parsed = _try_parse_json(value)
        if parsed is not None:
            value = parsed
    return value


def normalize_tool_result(
    content: Any, structured: Any, is_error: bool
) -> dict:
    """把 MCP CallToolResult 归一化为 {text, data, is_error}。"""
    text_parts: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text" and block.get("text"):
                    text_parts.append(str(block["text"]))
            else:
                t = getattr(block, "text", None)
                if t:
                    text_parts.append(str(t))
    data = _unwrap(structured) if structured is not None else None
    if data is None:
        data = _try_parse_json("\n".join(text_parts))
    if hasattr(data, "model_dump"):
        data = data.model_dump()
    return {"text": "\n".join(text_parts), "data": data, "is_error": bool(is_error)}


def _try_parse_json(text: str) -> Any:
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 尝试从文本中提取 json 代码块
    m = re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", text, flags=re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except json.JSONDecodeError:
            pass
    return None


def _extract_list(data: Any) -> Optional[list]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("data", "items", "bugs", "list", "result", "records"):
            val = data.get(key)
            if isinstance(val, list):
                return val
    return None


class TapdMcpClient:
    """MCP 版 Tapd 客户端，接口与 TapdClient(REST) 对齐。"""

    def __init__(self, workspace_id: str, mcp_cfg: dict):
        self.workspace_id = str(workspace_id)
        self.mcp = mcp_cfg or {}
        # 默认工具映射 + 用户覆盖（默认值即官方 mcp-server-tapd 的真实工具名）
        self.tool_map = {
            **_DEFAULT_TOOL_MAP,
            **(self.mcp.get("tool_map") or {}),
        }
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._session: Any = None
        self._tools: dict[str, Any] = {}
        self._error: Optional[str] = None

    # ------------------------------------------------------------------
    # 连接（后台事件循环 + 长驻会话）
    # ------------------------------------------------------------------
    def connect(self, timeout: float = 60.0) -> None:
        if self._thread and self._thread.is_alive():
            if self._ready.is_set():
                return
            self._ready.wait(timeout)
            if self._ready.is_set():
                return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="tapd-mcp", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise TapdError(f"连接 Tapd MCP 超时: {self._error or '未知错误'}")

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._session_main())
        except Exception as exc:  # 记录错误并唤醒 connect()
            self._error = str(exc)
            self._ready.set()

    def _env(self) -> dict:
        env = os.environ.copy()
        cfg = self.mcp
        if cfg.get("access_token"):
            env["TAPD_ACCESS_TOKEN"] = cfg["access_token"]
        if cfg.get("api_user"):
            env["TAPD_API_USER"] = cfg["api_user"]
        if cfg.get("api_password"):
            env["TAPD_API_PASSWORD"] = cfg["api_password"]
        if cfg.get("api_base_url"):
            env["TAPD_API_BASE_URL"] = cfg["api_base_url"]
        if cfg.get("tapd_base_url"):
            env["TAPD_BASE_URL"] = cfg["tapd_base_url"]
        env["TAPD_DEFAULT_WORKSPACE_ID"] = self.workspace_id
        return env

    def _transport(self) -> Any:
        transport = self.mcp.get("transport", "streamable-http")
        if transport == "stdio":
            from mcp.client.stdio import StdioServerParameters, stdio_client

            params = StdioServerParameters(
                command=self.mcp.get("command") or "uvx",
                args=self.mcp.get("args") or ["mcp-server-tapd"],
                env=self._env(),
            )
            return stdio_client(params)
        url = self.mcp.get("url") or ""
        if not url:
            raise TapdError(
                "未配置 Tapd MCP 的 url（config.yaml tapd.mcp.url），"
                "在腾讯云控制台 MCP Server 页面获取托管连接地址；或改用 transport: stdio"
            )
        from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

        http_client = None
        token = self.mcp.get("token") or os.environ.get("MCP_TOKEN", "")
        if token:
            http_client = create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
        return streamable_http_client(url, http_client=http_client, terminate_on_close=True)

    async def _session_main(self) -> None:
        from mcp import ClientSession

        transport = self._transport()
        async with transport as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                self._tools = {t.name: t for t in (result.tools or [])}
                self._session = session
                self._ready.set()
                while True:  # 保持会话长驻
                    await asyncio.sleep(3600)

    # ------------------------------------------------------------------
    # 工具调用（同步包装）
    # ------------------------------------------------------------------
    def _call(self, name: str, arguments: dict[str, Any], timeout: float = 120.0) -> dict:
        self.connect()
        fut = asyncio.run_coroutine_threadsafe(
            self._call_async(name, arguments), self._loop
        )
        try:
            return fut.result(timeout=timeout)
        except Exception as exc:
            raise TapdError(f"调用 MCP 工具 {name} 失败: {exc}") from exc

    async def _call_async(self, name: str, arguments: dict) -> dict:
        res = await self._session.call_tool(name, arguments=arguments)
        return normalize_tool_result(
            _safe_get(res, "content", "content_blocks"),
            _safe_get(res, "structured_content", "structuredContent", "data"),
            _safe_get(res, "is_error", "isError", default=False),
        )

    def _tool_for(self, op: str) -> str:
        override = self.tool_map.get(op)
        if override and override in self._tools:
            return override
        name = _match_tool(self._tools, op)
        if not name:
            raise TapdError(
                f"未找到适配 {op} 的 MCP 工具。可用工具: {sorted(self._tools)}。"
                f"可用 config.yaml tapd.mcp.tool_map.{op} 显式指定。"
            )
        return name

    def _filter_args(self, name: str, kwargs: dict) -> dict:
        tool = self._tools.get(name)
        schema = _safe_get(tool, "input_schema", "inputSchema", default={}) or {}
        props = (schema or {}).get("properties") if isinstance(schema, dict) else None
        if not props:
            return dict(kwargs)
        return {
            k: self._coerce(v, props[k])
            for k, v in kwargs.items()
            if k in props
        }

    @staticmethod
    def _coerce(value: Any, prop: Any) -> Any:
        """按 schema 属性类型强转（如 workspace_id 要求 number、id 要求 string）。"""
        if not isinstance(prop, dict):
            return value
        ptype = prop.get("type")
        if ptype in ("integer", "number") and isinstance(value, str):
            try:
                return int(value) if ptype == "integer" else float(value)
            except ValueError:
                return value
        if ptype == "boolean" and isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "是", "y")
        if ptype == "string" and not isinstance(value, str):
            return str(value)
        return value

    def _parse_bug(self, data: Any, bug_id: Optional[int] = None) -> Bug:
        if isinstance(data, list):
            data = data[0] if data else {}
        if isinstance(data, dict):
            # 先解实体包装（{"Bug": {...}} / {"data": {...}}）
            for key in ("data", "result", "bug"):
                val = data.get(key)
                if isinstance(val, list) and val:
                    data = val[0]
                    break
                if isinstance(val, dict):
                    data = val
                    break
            if "id" not in data and "title" not in data:
                for v in data.values():
                    if isinstance(v, dict) and ("id" in v or "title" in v):
                        data = v
                        break
        if not isinstance(data, dict):
            raise TapdError(f"无法从 MCP 结果解析 Bug: {str(data)[:300]}")
        if data.get("id") in (None, ""):
            data["id"] = bug_id or 0
        return Bug.from_dict(data, self.workspace_id)

    # ------------------------------------------------------------------
    # 业务接口（与 REST TapdClient 对齐）
    # ------------------------------------------------------------------
    def list_bugs(self, current_owner: Optional[str] = None, **filters: Any) -> list[Bug]:
        name = self._tool_for("list_bugs")
        kwargs = {
            "workspace_id": self.workspace_id,
            "current_owner": current_owner or filters.pop("current_owner", ""),
            "owner": current_owner or "",
            "workspaceId": self.workspace_id,
            "limit": 200,
            "page": 1,
        }
        kwargs.update(filters)
        result = self._call(name, self._filter_args(name, kwargs))
        if result["is_error"]:
            raise TapdError(f"MCP 工具 {name} 报错: {result['text'][:300]}")
        data = result["data"]
        items = _extract_list(data)
        if items is None:
            raise TapdError(
                f"MCP 工具 {name} 返回无法解析的列表（原始输出）:\n{result['text'][:800]}"
            )
        return [Bug.from_dict(it, self.workspace_id) for it in items if isinstance(it, dict)]

    def get_bug(self, bug_id: int) -> Bug:
        name = self._tool_for("get_bug")
        kwargs = {
            "workspace_id": self.workspace_id,
            "id": bug_id,
            "bug_id": bug_id,
            "workspaceId": self.workspace_id,
        }
        result = self._call(name, self._filter_args(name, kwargs))
        return self._parse_bug(result["data"], bug_id)

    def update_bug(self, bug_id: int, **fields: Any) -> dict:
        name = self._tool_for("update_bug")
        kwargs = {
            "workspace_id": self.workspace_id,
            "id": bug_id,
            "bug_id": bug_id,
            "workspaceId": self.workspace_id,
        }
        kwargs.update(fields)
        result = self._call(name, self._filter_args(name, kwargs))
        return result

    def add_comment(self, bug_id: int, content: str) -> dict:
        name = self._tool_for("add_comment")
        kwargs = {
            "workspace_id": self.workspace_id,
            "id": bug_id,
            "bug_id": bug_id,
            "entry_id": bug_id,
            "entry_type": "bug",
            "content": content,
            "description": content,  # tapd_create_comment 的内容参数是 description
            "workspaceId": self.workspace_id,
        }
        result = self._call(name, self._filter_args(name, kwargs))
        return result

    # ------------------------------------------------------------------
    # 调试
    # ------------------------------------------------------------------
    def dump_tools(self) -> str:
        self.connect()
        lines = [f"发现 {len(self._tools)} 个 MCP 工具："]
        for name in sorted(self._tools):
            tool = self._tools[name]
            desc = (_safe_get(tool, "description", default="") or "").strip()
            schema = _safe_get(tool, "input_schema", "inputSchema", default={}) or {}
            props = ", ".join((schema.get("properties") or {}).keys()) if isinstance(schema, dict) else ""
            lines.append(f"- {name}: {desc[:80]}  args=({props})")
        return "\n".join(lines)
