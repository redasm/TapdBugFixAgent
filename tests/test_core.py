"""核心逻辑冒烟测试（纯本地，无网络/p4 依赖）。"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tapd_agent import descgen
from tapd_agent.agents.base import (
    AgentCancelledError,
    AgentRuntimeError,
    extract_final_json,
    result_from_output,
    run_cli,
    run_cli_streaming,
)
from tapd_agent.agents.claude_cli import _extract_result_text, progress_from_line
from tapd_agent.config import Config, RepoConfig, WorkspaceConfig, load_config, validate_config
from tapd_agent.models import AgentResult, Bug
from tapd_agent.p4util import P4Client, P4Error, set_spec_field
from tapd_agent.state import StateStore
from tapd_agent.verify import VerificationError, check_and_prepare_p4
from tapd_agent.worker import Worker


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

    def test_model_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(str(Path(tmp) / "t.db"))
            try:
                bug = make_bug()
                store.upsert_job(bug, agent_state="in_progress", agent="claude", model="claude-sonnet-5")
                job = store.get_job(bug.id)
                self.assertEqual(job["agent"], "claude")
                self.assertEqual(job["model"], "claude-sonnet-5")
                # 旧库迁移：新表必有 model 列
                cols = [r[1] for r in store.conn.execute("PRAGMA table_info(jobs)")]
                self.assertIn("model", cols)
            finally:
                store.close()

    def test_model_column_migration_existing_db(self):
        """模拟旧库（无 model 列），打开后应自动补列。"""
        import sqlite3 as _sq

        with tempfile.TemporaryDirectory() as tmp:
            p = str(Path(tmp) / "old.db")
            conn = _sq.connect(p)
            # 模拟真实旧库：即当前 schema 减去 model 列
            conn.executescript(
                """CREATE TABLE control (
                     id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, updated_at TEXT);
                   CREATE TABLE jobs (
                     bug_id INTEGER PRIMARY KEY, workspace_id TEXT, title TEXT, priority TEXT,
                     priority_label TEXT, tapd_status TEXT, agent_state TEXT, changelist INTEGER,
                     generated_description TEXT, files TEXT, manual_assets TEXT, failure_reason TEXT,
                     agent TEXT, attempts INTEGER DEFAULT 0, started_at TEXT, finished_at TEXT);
                   CREATE TABLE events (
                     id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, level TEXT, bug_id INTEGER, msg TEXT);
                   CREATE INDEX idx_jobs_state ON jobs(agent_state);
                   CREATE INDEX idx_events_bug ON events(bug_id);"""
            )
            conn.commit()
            conn.close()
            store = StateStore(p)
            try:
                cols = [r[1] for r in store.conn.execute("PRAGMA table_info(jobs)")]
                self.assertIn("model", cols)
            finally:
                store.close()


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


class TestSyncRetry(unittest.TestCase):
    """sync 在瞬时 P4Error 时应重试，最终成功；持续失败时保留最后一次错误。"""

    def _client(self):
        return P4Client("C:\\tmp", {"client": "test-client"})

    def test_sync_retries_then_succeeds(self):
        client = self._client()
        calls = {"n": 0}

        def fake_run(args, **kwargs):
            calls["n"] += 1
            if calls["n"] < 3:
                raise P4Error("rename: failed to rename ... 文件被占用")
            return "updated"

        client.run = fake_run
        out = client.sync(retries=3, retry_delay=0)
        self.assertEqual(out, "updated")
        self.assertEqual(calls["n"], 3)

    def test_sync_fails_with_last_error(self):
        client = self._client()
        last_err = None

        def fake_run(args, **kwargs):
            nonlocal last_err
            last_err = P4Error("rename: failed to rename ... 文件被占用")
            raise last_err

        client.run = fake_run
        with self.assertRaises(P4Error):
            client.sync(retries=2, retry_delay=0)
        self.assertIsNotNone(last_err)


class _FakeP4:
    """可编程的假 p4，用于验证 reconcile 兜底分支。"""

    def __init__(self, opened, preview):
        self._opened = list(opened)
        self.preview = preview
        self.reconciled = False

    def opened(self):
        return list(self._opened)

    def reconcile_preview(self):
        return self.preview

    def reconcile(self):
        self.reconciled = True
        if self.preview.strip() and not self._opened:
            self._opened = [
                {"depot": "//nami/.../x.cpp", "action": "edit",
                 "changelist": "default", "type": "text"}
            ]


class TestCheckAndPrepareP4(unittest.TestCase):
    def test_reconcile_fallback_when_agent_forgot_p4_edit(self):
        """Agent 改了磁盘文件但没 p4 edit：opened 为空、reconcile 预览有差异
        → 应自动 reconcile 打开，而不是直接判失败。"""
        fake = _FakeP4(opened=[], preview="...//x.cpp#1 - edit from D:/...")
        opened = check_and_prepare_p4(fake)
        self.assertTrue(fake.reconciled)
        self.assertEqual(len(opened), 1)

    def test_no_change_at_all_raises(self):
        fake = _FakeP4(opened=[], preview="")
        with self.assertRaises(VerificationError):
            check_and_prepare_p4(fake)
        self.assertFalse(fake.reconciled)

    def test_opened_present_no_preview_skips_reconcile(self):
        fake = _FakeP4(
            opened=[{"depot": "//nami/.../x.cpp", "action": "edit",
                     "changelist": "default", "type": "text"}],
            preview="",
        )
        opened = check_and_prepare_p4(fake)
        self.assertFalse(fake.reconciled)
        self.assertEqual(len(opened), 1)


@unittest.skipUnless(os.name == "nt", "Windows 特有（shell=True shim 行为）")
class TestRunCliTimeout(unittest.TestCase):
    def test_timeout_kills_process_tree(self):
        """超时时应返回 AgentRuntimeError 且进程树被杀，而不是挂住。"""
        import subprocess  # noqa: F401

        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "sleep.py")
            with open(script, "w") as f:
                f.write("import time\ntime.sleep(120)\n")
            t0 = time.time()
            with self.assertRaises(AgentRuntimeError) as cm:
                run_cli([sys.executable, script], cwd=d, timeout_s=1)
            self.assertLess(time.time() - t0, 20, "超时处理不应挂住")
            self.assertIn("超时", str(cm.exception))


def _write_sleep(d: str) -> str:
    script = os.path.join(d, "sleep.py")
    with open(script, "w") as f:
        f.write("import time\ntime.sleep(120)\n")
    return script


class TestCancelEvent(unittest.TestCase):
    """人工取消（web 暂停/关闭）应杀进程树并抛 AgentCancelledError。"""

    def test_run_cli_cancelled(self):
        with tempfile.TemporaryDirectory() as d:
            evt = threading.Event()
            t = threading.Timer(0.5, evt.set)
            t.start()
            try:
                t0 = time.time()
                with self.assertRaises(AgentCancelledError):
                    run_cli(
                        [sys.executable, _write_sleep(d)], cwd=d,
                        timeout_s=60, cancel_event=evt,
                    )
                self.assertLess(time.time() - t0, 20, "取消后不应挂住")
            finally:
                t.cancel()

    def test_run_cli_streaming_cancelled(self):
        with tempfile.TemporaryDirectory() as d:
            evt = threading.Event()
            t = threading.Timer(0.5, evt.set)
            t.start()
            try:
                t0 = time.time()
                with self.assertRaises(AgentCancelledError):
                    run_cli_streaming(
                        [sys.executable, _write_sleep(d)], cwd=d,
                        timeout_s=60, cancel_event=evt,
                    )
                self.assertLess(time.time() - t0, 20, "取消后不应挂住")
            finally:
                t.cancel()

    def test_not_cancelled_runs_to_completion(self):
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "ok.py")
            with open(script, "w") as f:
                f.write("print('done')\n")
            evt = threading.Event()
            proc = run_cli_streaming(
                [sys.executable, script], cwd=d, timeout_s=60,
                cancel_event=evt,
            )
            self.assertEqual(proc.returncode, 0)
            self.assertIn("done", proc.stdout)


class TestStreamingRunner(unittest.TestCase):
    def test_streaming_reports_progress_per_line(self):
        """流式执行应逐行回调 on_progress，且仍累计完整 stdout。"""
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "print_lines.py")
            with open(script, "w") as f:
                f.write("for i in range(3):\n    print('line', i)\n")
            progress = []
            proc = run_cli_streaming(
                [sys.executable, script], cwd=d, timeout_s=60,
                on_progress=progress.append,
            )
            self.assertEqual(proc.returncode, 0)
            self.assertGreaterEqual(len(progress), 3, "每行应触发一次回调")
            self.assertIn("line 0", proc.stdout)


class TestWebMerge(unittest.TestCase):
    """管理台列表/详情：Tapd 实时 bug 与本地处理状态合并。"""

    def _worker(self):
        store = StateStore(":memory:")
        cfg = Config()
        cfg.workspaces = [WorkspaceConfig(workspace_id="111", owner="me")]
        return Worker(cfg, store)

    def test_list_includes_unprocessed(self):
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        rows = w.list_bugs_for_web()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["agent_state"])
        self.assertFalse(rows[0]["has_local"])

    def test_list_merges_job(self):
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        w.store.upsert_job(bug, agent_state="failed")
        rows = w.list_bugs_for_web()
        self.assertEqual(rows[0]["agent_state"], "failed")
        self.assertTrue(rows[0]["has_local"])

    def test_list_excludes_rejected(self):
        w = self._worker()
        b1 = make_bug(id=1, status="new")
        b2 = make_bug(id=2, status="rejected")
        w._fetch_my_bugs = lambda: [b1, b2]
        rows = w.list_bugs_for_web()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["bug_id"], "1")

    def test_bug_id_is_string_in_web_payloads(self):
        """bug_id 必须字符串传输：大整数（>2^53）在 JS JSON.parse 会丢精度。"""
        w = self._worker()
        big = 1152729922001234007
        bug = make_bug(id=big)
        w._fetch_my_bugs = lambda: [bug]
        rows = w.list_bugs_for_web()
        self.assertEqual(rows[0]["bug_id"], str(big))
        d = w.bug_detail_for_web(big)
        self.assertEqual(d["bug_id"], str(big))
        w.store.upsert_job(bug, agent_state="in_progress")
        d2 = w.bug_detail_for_web(big)
        self.assertEqual(d2["bug_id"], str(big), "job 字段覆盖后仍应为字符串")

    def test_detail_unprocessed(self):
        w = self._worker()
        bug = make_bug(id=1152729922001254287, description="锻造引导后轮盘不显示")
        w._fetch_my_bugs = lambda: [bug]
        d = w.bug_detail_for_web(bug.id)
        self.assertEqual(d["description"], "锻造引导后轮盘不显示")
        self.assertIsNone(d["agent_state"])
        self.assertEqual(d["files"], "[]")
        self.assertEqual(d["events"], [])
        self.assertEqual(d["progress"], [])

    def test_list_and_detail_include_agent_model(self):
        """处理开始时就写 agent/model，列表与详情能实时展示。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        w.store.upsert_job(bug, agent_state="in_progress")
        w.store.update_job(bug.id, agent="codex", model="codex-mini")
        rows = w.list_bugs_for_web()
        self.assertEqual(rows[0]["agent"], "codex")
        self.assertEqual(rows[0]["model"], "codex-mini")
        d = w.bug_detail_for_web(bug.id)
        self.assertEqual(d["agent"], "codex")
        self.assertEqual(d["model"], "codex-mini")

    def test_unprocessed_has_no_agent_model(self):
        """未处理 bug（无 job）不显示 agent/model，前端走 '-' 分支。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        rows = w.list_bugs_for_web()
        self.assertIsNone(rows[0]["agent"])
        self.assertIsNone(rows[0]["model"])

    def test_detail_merges_job_events(self):
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        w.store.upsert_job(bug, agent_state="in_progress")
        w.store.add_event("开始处理", bug_id=bug.id)
        d = w.bug_detail_for_web(bug.id)
        self.assertEqual(d["agent_state"], "in_progress")
        self.assertEqual(len(d["events"]), 1)
        self.assertTrue(d["has_local"])

    def test_detail_splits_progress_events(self):
        """debug 级事件进 progress（Agent 实时进度），系统事件留在 events。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        w.store.upsert_job(bug, agent_state="in_progress")
        w.store.add_event("Agent: Grep pattern", level="debug", bug_id=bug.id)
        w.store.add_event("p4 sync 完成", bug_id=bug.id)
        d = w.bug_detail_for_web(bug.id)
        self.assertEqual([e["msg"] for e in d["progress"]], ["Agent: Grep pattern"])
        self.assertEqual([e["msg"] for e in d["events"]], ["p4 sync 完成"])

    def test_detail_not_found(self):
        w = self._worker()
        w._fetch_my_bugs = lambda: []
        w._tapd = lambda ws: _FakeTapd([])
        self.assertIsNone(w.bug_detail_for_web(999999))

    def test_detail_fetches_by_id_when_not_in_list(self):
        w = self._worker()
        bug = make_bug(id=1152729922001254287, description="直接按 id 拉取")
        w._fetch_my_bugs = lambda: []
        w._tapd = lambda ws: _FakeTapd([bug])
        d = w.bug_detail_for_web(bug.id)
        self.assertEqual(d["title"], bug.title)
        self.assertIsNone(d["agent_state"])

    def test_skip_unprocessed_creates_record(self):
        """未处理 bug 也能跳过：落一条 skipped 记录，worker 不再抓它。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        self.assertTrue(w.skip_bug(bug.id))
        job = w.store.get_job(bug.id)
        self.assertIsNotNone(job)
        self.assertEqual(job["agent_state"], "skipped")
        # 从可处理队列中消失
        self.assertEqual(w.fetch_actionable(), [])

    def test_skip_unknown_returns_false(self):
        w = self._worker()
        w._fetch_my_bugs = lambda: []
        w._tapd = lambda ws: _FakeTapd([])
        self.assertFalse(w.skip_bug(999999))
        self.assertIsNone(w.store.get_job(999999))

    def test_skip_not_in_list_fetches_by_id(self):
        """不在「分配给我」列表的 bug，跳过时按 id 直拉再落记录。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: []
        w._tapd = lambda ws: _FakeTapd([bug])
        self.assertTrue(w.skip_bug(bug.id))
        self.assertEqual(w.store.get_job(bug.id)["agent_state"], "skipped")

    def test_retry_unprocessed_is_noop_success(self):
        """未处理 bug「重试」= 确保可处理，幂等成功（它本就在队列里）。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        self.assertTrue(w.retry_bug(bug.id))
        self.assertIsNone(w.store.get_job(bug.id))

    def test_retry_unknown_returns_false(self):
        w = self._worker()
        w._fetch_my_bugs = lambda: []
        w._tapd = lambda ws: _FakeTapd([])
        self.assertFalse(w.retry_bug(999999))

    def test_skip_failed_bug_still_works(self):
        """已有本地记录（failed）的 bug，跳过走原逻辑。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        w._fetch_my_bugs = lambda: [bug]
        w.store.upsert_job(bug, agent_state="failed")
        self.assertTrue(w.skip_bug(bug.id))
        self.assertEqual(w.store.get_job(bug.id)["agent_state"], "skipped")


class TestControlCancel(unittest.TestCase):
    """暂停/关闭能中断正在跑的 agent，且被打断的 bug 回到待处理队列。"""

    def _worker(self):
        store = StateStore(":memory:")
        cfg = Config()
        cfg.workspaces = [WorkspaceConfig(workspace_id="111", owner="me")]
        return Worker(cfg, store)

    def test_stop_pause_set_cancel_resume_clears(self):
        w = self._worker()
        w.start()
        self.assertFalse(w._cancel.is_set())
        w.pause()
        self.assertTrue(w._cancel.is_set())
        self.assertEqual(w.state, "paused")
        w.resume()
        self.assertFalse(w._cancel.is_set())
        self.assertEqual(w.state, "running")
        w.stop()
        self.assertTrue(w._cancel.is_set())
        self.assertEqual(w.state, "stopped")

    def test_process_bug_interrupted_resets_to_pending(self):
        """agent 抛 AgentCancelledError → bug 回 pending，不算失败、不回写 Tapd。"""
        w = self._worker()
        bug = make_bug(id=1152729922001254287)
        repo = RepoConfig(name="r", path="C:\\tmp", agent="claude", test_cmd="")

        class _CancelledAgent:
            def run(self, *a, **k):
                self.got_cancel = k.get("cancel_event")
                raise AgentCancelledError("Agent 调用被人工取消")

        class _P4:
            def sync(self, **k):
                pass

        w._resolve_repo = lambda b: repo
        with mock.patch("tapd_agent.worker.P4Client", return_value=_P4()):
            with mock.patch("tapd_agent.worker.build_agent") as ba:
                fake = _CancelledAgent()
                ba.return_value = fake
                w.process_bug(bug)

        job = w.store.get_job(bug.id)
        self.assertEqual(job["agent_state"], "pending")
        self.assertIsNone(job["failure_reason"])
        self.assertTrue(fake.got_cancel, "worker 应把取消事件传给 agent")
        # 不应有失败事件；应有一条「中断」事件
        events = w.store.list_events(bug.id)
        self.assertTrue(any("人工中断" in e["msg"] for e in events))
        self.assertFalse(any("失败" in e["msg"] for e in events))


class _FakeTapd:
    def __init__(self, bugs=None):
        self._bugs = bugs or []

    def get_bug(self, bug_id):
        for b in self._bugs:
            if b.id == bug_id:
                return b
        raise RuntimeError("not found")


class TestStreamJsonParsing(unittest.TestCase):
    def test_progress_from_tool_use(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Grep", "input": {"pattern": "foo"}}]},
        })
        msg = progress_from_line(line)
        self.assertIsNotNone(msg)
        self.assertIn("Grep", msg)
        self.assertIn("foo", msg)

    def test_progress_from_text(self):
        line = json.dumps({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "分析中"}]},
        })
        self.assertEqual(progress_from_line(line), "Agent: 分析中")

    def test_progress_ignores_unrelated(self):
        self.assertIsNone(progress_from_line("not json"))
        self.assertIsNone(progress_from_line(json.dumps({"type": "user"})))
        self.assertIsNone(progress_from_line(json.dumps({"type": "result"})))

    def test_extract_result_text(self):
        out = (
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'
            '{"type":"result","result":"FINAL_RESULT: {\\"summary\\":\\"ok\\"}"}\n'
        )
        self.assertIn("FINAL_RESULT", _extract_result_text(out))


if __name__ == "__main__":
    unittest.main()
