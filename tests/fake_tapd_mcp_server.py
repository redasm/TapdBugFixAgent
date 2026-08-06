"""测试夹具：本地 stdio 模式的假 Tapd MCP 服务端。

工具名与参数刻意对齐真实 mcp-server-tapd / @xihe-lab/tapd-mcp-server：
- tapd_get_bugs        （列表，current_owner/limit/page/id 过滤）
- tapd_update_bug      （更新状态）
- tapd_create_comment  （评论，内容参数是 description）
"""
import json
import sys

from mcp.server import MCPServer

server = MCPServer(name="fake-tapd", version="0.1")

BUGS = [
    {
        "id": 1152729922001234007,
        "name": "登录页偶现崩溃",
        "description": "快速点击登录按钮时偶现崩溃。",
        "status": "new",
        "priority": "1",
        "priority_label": "高",
        "severity_label": "严重",
        "module": "login",
        "current_owner": "me",
        "reporter": "tester",
        "created": "2026-08-05 10:00:00",
    },
    {
        "id": 1152729922001234008,
        "name": "配置表数值越界",
        "description": "某个数值超出合理范围。",
        "status": "new",
        "priority": "2",
        "priority_label": "中",
        "module": "config",
        "current_owner": "me",
        "reporter": "tester",
        "created": "2026-08-05 11:00:00",
    },
]


@server.tool(name="tapd_get_bugs", description="Query TAPD bugs with filters")
def tapd_get_bugs(
    workspace_id: int,
    current_owner: str = "",
    id: int = 0,
    limit: int = 200,
    page: int = 1,
) -> str:
    items = [
        b for b in BUGS
        if (not current_owner or b["current_owner"] == current_owner)
        and (not id or b["id"] == id)
    ]
    start = (page - 1) * limit
    return json.dumps({"data": items[start: start + limit]}, ensure_ascii=False)


@server.tool(name="tapd_update_bug", description="Update an existing bug in TAPD")
def tapd_update_bug(workspace_id: int, id: int, status: str = "") -> str:
    for b in BUGS:
        if b["id"] == id:
            if status:
                b["status"] = status
            return json.dumps({"ok": True, "id": id, "status": b["status"]})
    return json.dumps({"ok": False, "id": id})


@server.tool(name="tapd_create_comment", description="Create a new comment on a story, bug, or task")
def tapd_create_comment(
    workspace_id: int, entry_type: str, entry_id: int, description: str
) -> str:
    return json.dumps(
        {"ok": True, "entry_id": entry_id, "description": description},
        ensure_ascii=False,
    )


if __name__ == "__main__":
    server.run(transport="stdio")
    sys.exit(0)
