"""核心逻辑冒烟测试（纯本地，无网络/p4 依赖）。"""
import json
import tempfile
import unittest
from pathlib import Path

from tapd_agent import descgen
from tapd_agent.agents.base import extract_final_json, result_from_output
from tapd_agent.config import Config, load_config, validate_config
from tapd_agent.models import AgentResult, Bug
from tapd_agent.p4util import set_spec_field
from tapd_agent.state import StateStore


def make_bug(**over):
    data = dict(
        id=1152729922001234007,
        workspace_id="1152729922",
        title="登录页偶现崩溃",
        description="在快速点击登录按钮时偶现崩溃，堆栈在 xxx。",
        status="new",
        priority="1",
        priority_label="高",
        severity="严重",
        module="login",
        current_owner="me",
        reporter="tester",
        created="2026-08-05 10:00:00",
    )
    data.update(over)
    return Bug.from_dict(data, data["workspace_id"])


class TestDescGen(unittest.TestCase):
    def test_build_description(self):
        bug = make_bug()
        result = AgentResult(
            ok=True,
            summary="修复了空指针，增加判空。",
            changed_files=["src/login.cpp"],
            manual_assets=[{"path": "Assets/login.prefab", "reason": "Unity 二进制资源"}],
        )
        desc = descgen.build_description(bug, result, test_output="pytest 1 passed")
        self.assertIn("[TAPD-1152729922001234007]", desc)
        self.assertIn("登录页偶现崩溃", desc)
        self.assertIn("需人工处理的资源", desc)
        self.assertIn("Unity 二进制资源", desc)
        self.assertIn("pytest 1 passed", desc)

    def test_manual_only_description(self):
        bug = make_bug()
        result = AgentResult(ok=True, summary="无代码改动", manual_assets=[{"path": "a.xlsx", "reason": "表格"}])
        desc = descgen.build_description(bug, result)
        self.assertNotIn("修改文件:", desc)
        self.assertIn("a.xlsx", desc)


class TestConfig(unittest.TestCase):
    def test_priority_rank(self):
        cfg = Config()  # 显式空配置（默认优先级权重），不依赖 cwd 是否有 config.yaml
        self.assertEqual(cfg.priority_rank(make_bug(priority="1")), 0)
        self.assertEqual(cfg.priority_rank(make_bug(priority="4")), 3)
        # 优先级与 label 都未知 -> 排最后
        self.assertGreater(cfg.priority_rank(make_bug(priority="未知值", priority_label="")), 3)

    def test_load_from_yaml(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            cfg_path.write_text(
                """
mode: review
workspaces:
  - workspace_id: "111"
    owner: me
    repos:
      - name: p
        path: "."
        test_cmd: "echo ok"
priority_weight:
  高: 0
  低: 1
""",
                encoding="utf-8",
            )
            cfg = load_config(str(cfg_path))
            self.assertEqual(cfg.workspaces[0].workspace_id, "111")
            self.assertEqual(cfg.workspaces[0].repos[0].name, "p")
            self.assertEqual(cfg.priority_weight["低"], 1)

    def test_validate(self):
        cfg = Config()  # 显式空配置，不依赖 cwd 是否有 config.yaml
        problems = validate_config(cfg)
        self.assertTrue(any("TAPD" in p for p in problems))  # 缺少凭据应被报出


class TestState(unittest.TestCase):
    def test_store_crud(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(str(Path(tmp) / "t.db"))
            try:
                self.assertEqual(store.get_control(), "stopped")
                store.set_control("running")
                self.assertEqual(store.get_control(), "running")

                bug = make_bug()
                store.upsert_job(bug, agent_state="in_progress")
                store.update_job(bug.id, agent_state="resolved", changelist=42)
                job = store.get_job(bug.id)
                self.assertEqual(job["changelist"], 42)
                self.assertEqual(job["agent_state"], "resolved")

                store.add_event("test", bug_id=bug.id)
                events = store.list_events(bug.id)
                self.assertEqual(len(events), 1)
                self.assertEqual(store.job_count(), 1)
                self.assertEqual(store.job_state_counts()["resolved"], 1)
            finally:
                store.close()  # Windows: 关闭连接后才能删除临时目录


class TestP4Spec(unittest.TestCase):
    def test_set_description(self):
        spec = (
            "Change:\tnew\n\n"
            "Client:\ttapd-agent_x\n\n"
            "Description:\n\t<enter description here>\n\n"
            "Files:\n\t//depot/a.cpp#1 edit\n"
        )
        out = set_spec_field(spec, "Description", "第一行\n第二行")
        self.assertIn("Description:\n\t第一行\n\t第二行", out)
        self.assertIn("//depot/a.cpp#1 edit", out)  # Files 段保留
        # 字段值行须以 Tab 缩进（p4 spec 要求）
        for line in out.splitlines():
            if line and line[0] in " \t" and line.strip() and line.strip().startswith(("第一行", "第二行")):
                self.assertTrue(line.startswith("\t"))


class TestAgentParsing(unittest.TestCase):
    def test_extract_final_json_marker(self):
        text = 'xx\nFINAL_RESULT:\n```json\n{"summary": "ok", "changed_files": ["a.cpp"], "manual_assets": [{"path":"p","reason":"r"}]}\n```'
        data = extract_final_json(text)
        self.assertEqual(data["summary"], "ok")
        self.assertEqual(data["changed_files"], ["a.cpp"])

    def test_result_from_output(self):
        ar = result_from_output(
            'FINAL_RESULT: {"summary": "修复", "manual_assets": [{"path":"a.prefab"}]}', 0
        )
        self.assertTrue(ar.ok)
        self.assertEqual(ar.summary, "修复")
        self.assertEqual(len(ar.manual_assets), 1)

    def test_no_json_fallback(self):
        ar = result_from_output("some random text", 0)
        self.assertTrue(ar.ok)
        self.assertTrue(ar.summary)


if __name__ == "__main__":
    unittest.main()
