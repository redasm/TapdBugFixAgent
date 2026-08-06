"""MCP 客户端测试：纯函数单元 + 本地 stdio 假服务端端到端。"""
import sys
import unittest
from pathlib import Path

from tapd_agent.tapd.mcp_client import (
    TapdMcpClient,
    _match_tool,
    _try_parse_json,
    _extract_list,
    normalize_tool_result,
)

FAKE_SERVER = str(Path(__file__).parent / "fake_tapd_mcp_server.py")


class _Tool:
    def __init__(self, name, description="", input_schema=None):
        self.name = name
        self.description = description
        self.input_schema = input_schema or {"type": "object", "properties": {}}


class TestMatchTool(unittest.TestCase):
    def _tools(self):
        return {
            "tapd_get_bugs": _Tool(
                "tapd_get_bugs", "Query TAPD bugs with filters",
                {"type": "object", "properties": {"workspace_id": {}, "current_owner": {}, "limit": {}, "page": {}, "status": {}}},
            ),
            "tapd_get_bug_count": _Tool(
                "tapd_get_bug_count", "Get the count of bugs matching filters",
                {"type": "object", "properties": {"workspace_id": {}, "current_owner": {}}},
            ),
            "tapd_update_bug": _Tool("tapd_update_bug", "Update an existing bug in TAPD"),
            "tapd_create_comment": _Tool(
                "tapd_create_comment", "Create a new comment on a story, bug, or task",
                {"type": "object", "properties": {"workspace_id": {}, "entry_type": {}, "entry_id": {}, "description": {}}},
            ),
            "tapd_get_release": _Tool("tapd_get_release", "获取发布信息"),
        }

    def test_list_bugs_prefers_list_over_count(self):
        # count 工具应被排除；带 limit/page 的列表工具胜出
        self.assertEqual(_match_tool(self._tools(), "list_bugs"), "tapd_get_bugs")

    def test_update_bug_exact(self):
        self.assertEqual(_match_tool(self._tools(), "update_bug"), "tapd_update_bug")

    def test_add_comment(self):
        self.assertEqual(_match_tool(self._tools(), "add_comment"), "tapd_create_comment")

    def test_no_match(self):
        tools = {"tapd_get_release": _Tool("tapd_get_release", "获取发布信息")}
        self.assertIsNone(_match_tool(tools, "list_bugs"))


class TestParsing(unittest.TestCase):
    def test_parse_json_text(self):
        data = _try_parse_json('{"data": [1, 2]}')
        self.assertEqual(data["data"], [1, 2])

    def test_parse_json_block(self):
        text = '结果如下：\n```json\n{"ok": true}\n```\n完毕'
        self.assertEqual(_try_parse_json(text)["ok"], True)

    def test_extract_list(self):
        self.assertEqual(_extract_list({"data": [{"id": 1}]}), [{"id": 1}])
        self.assertEqual(_extract_list([{"id": 1}]), [{"id": 1}])
        self.assertIsNone(_extract_list({"text": "no"}))

    def test_normalize_structured(self):
        out = normalize_tool_result([], {"data": [{"id": 1}]}, False)
        self.assertEqual(out["data"]["data"], [{"id": 1}])
        self.assertFalse(out["is_error"])


class TestTapdMcpE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = {
            "transport": "stdio",
            "command": sys.executable,
            "args": [FAKE_SERVER],
            "access_token": "dummy",
        }
        cls.client = TapdMcpClient("123", cls.cfg)
        cls.client.connect(timeout=30)

    def test_discover_tools(self):
        self.assertIn("tapd_get_bugs", self.client._tools)
        self.assertIn("tapd_update_bug", self.client._tools)
        self.assertIn("tapd_create_comment", self.client._tools)

    def test_list_bugs(self):
        bugs = self.client.list_bugs(current_owner="me")
        self.assertEqual(len(bugs), 2)
        ids = sorted(b.id for b in bugs)
        self.assertEqual(ids, [1152729922001234007, 1152729922001234008])
        # 字段归一化
        first = bugs[0]
        self.assertEqual(first.priority_label, "高")
        self.assertTrue(first.url.startswith("https://www.tapd.cn/123/"))

    def test_get_bug(self):
        bug = self.client.get_bug(1152729922001234008)
        self.assertEqual(bug.id, 1152729922001234008)
        self.assertEqual(bug.title, "配置表数值越界")

    def test_update_and_comment(self):
        res = self.client.update_bug(1152729922001234007, status="resolved")
        self.assertFalse(res["is_error"])
        self.assertEqual(res["data"]["status"], "resolved")
        # 内容参数正确映射到 description
        res2 = self.client.add_comment(1152729922001234007, "自动修复完成")
        self.assertEqual(res2["data"]["description"], "自动修复完成")

    def test_empty_list_ok(self):
        bugs = self.client.list_bugs(current_owner="not_exist")
        self.assertEqual(bugs, [])


if __name__ == "__main__":
    unittest.main()
