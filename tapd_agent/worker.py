"""编排工作线程：受控循环 + 分类（resolved/partial/manual_only/failed）+ Tapd 回写。"""
from __future__ import annotations

import threading
import time
from typing import Optional

from . import descgen, verify
from .agents import build_agent, build_fix_prompt
from .config import Config, RepoConfig, WorkspaceConfig
from .models import AgentResult, Bug, dumps, truncate
from .p4util import P4Client
from .state import StateStore, _now
from .tapd import TapdClient, TapdError

# 终态：已处理（不会自动重新处理）
_TERMINAL_STATES = ("resolved", "partial", "manual_only", "failed", "skipped")
_FETCH_CACHE_SECONDS = 60


class Worker:
    def __init__(self, config: Config, store: StateStore):
        self.config = config
        self.store = store
        self.current_bug_id: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_thread = threading.Event()
        self._wake = threading.Event()
        self._clients: dict[str, TapdClient] = {}
        self._last_fetch = 0.0
        self._last_fetch_result: Optional[list[Bug]] = None

    # ------------------------------------------------------------------
    # 控制 API（web 调用）
    # ------------------------------------------------------------------
    def start(self) -> str:
        self.store.set_control("running")
        self.store.add_event("已开启自动处理")
        self._wake.set()
        return self.state

    def pause(self) -> str:
        self.store.set_control("paused")
        self.store.add_event("已暂停（当前 bug 处理完后停下）")
        return self.state

    def resume(self) -> str:
        return self.start()

    def stop(self) -> str:
        self.store.set_control("stopped")
        self.store.add_event("已关闭自动处理")
        self._wake.set()
        return self.state

    @property
    def state(self) -> str:
        return self.store.get_control()

    # ------------------------------------------------------------------
    # 工作线程
    # ------------------------------------------------------------------
    def start_loop(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="tapd-worker", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop_thread.is_set():
            if self.store.get_control() == "running":
                try:
                    processed = self.process_next()
                except Exception as exc:  # 兜底，避免线程死掉
                    self.store.add_event(f"工作循环异常: {exc}", "error")
                    processed = False
                self._wake.wait(3 if processed else 10)
                self._wake.clear()
            else:
                self._wake.wait(2)
                self._wake.clear()

    def shutdown(self) -> None:
        self._stop_thread.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    # ------------------------------------------------------------------
    # 队列
    # ------------------------------------------------------------------
    def _tapd(self, ws: WorkspaceConfig) -> TapdClient:
        backend = self.config.tapd.get("backend", "rest")
        if backend == "mcp":
            key = "mcp"
            if key not in self._clients:
                from .tapd import TapdMcpClient

                client = TapdMcpClient(ws.workspace_id, self.config.tapd.get("mcp") or {})
                client.connect()
                self._clients[key] = client
            return self._clients[key]
        key = ws.workspace_id
        if key not in self._clients:
            self._clients[key] = TapdClient(
                self.config.tapd.get("api_user", ""),
                self.config.tapd.get("api_password", ""),
                ws.workspace_id,
            )
        return self._clients[key]

    def _workspace_of(self, bug: Bug) -> WorkspaceConfig:
        for ws in self.config.workspaces:
            if ws.workspace_id == bug.workspace_id:
                return ws
        return self.config.workspaces[0]

    def _fetch_my_bugs(self) -> list[Bug]:
        now = time.monotonic()
        if (
            self._last_fetch_result is not None
            and now - self._last_fetch < _FETCH_CACHE_SECONDS
        ):
            return self._last_fetch_result
        bugs: list[Bug] = []
        for ws in self.config.workspaces:
            try:
                fetched = self._tapd(ws).list_bugs(current_owner=ws.owner)
                for b in fetched:
                    b.workspace_id = ws.workspace_id
                bugs.extend(fetched)
            except TapdError as exc:
                self.store.add_event(f"workspace {ws.workspace_id} 拉取失败: {exc}", "error")
        self._last_fetch = now
        self._last_fetch_result = bugs
        return bugs

    def fetch_actionable(self) -> list[Bug]:
        """分配给我的、未处理的 bug，按优先级排序（数字小优先，再按创建时间）。"""
        actionable = []
        for b in self._fetch_my_bugs():
            if b.status in self.config.exclude_status:
                continue
            job = self.store.get_job(b.id)
            if job and job["agent_state"] in _TERMINAL_STATES:
                continue  # 终态不自动重试（重试需人工从 Web 触发）
            if job and job["agent_state"] == "in_progress":
                continue  # 正在处理（防重入）
            actionable.append(b)
        actionable.sort(key=lambda b: (self.config.priority_rank(b), b.created or ""))
        return actionable[: self.config.max_bugs_per_run]

    def process_next(self) -> bool:
        bugs = self.fetch_actionable()
        if not bugs:
            return False
        bug = bugs[0]
        self.current_bug_id = bug.id
        try:
            self.process_bug(bug)
        finally:
            self.current_bug_id = None
        return True

    def run_batch(self, limit: Optional[int] = None) -> int:
        """同步处理一批（CLI 用，忽略控制态）。"""
        limit = limit or self.config.max_bugs_per_run
        count = 0
        while count < limit:
            if not self.process_next():
                break
            count += 1
        return count

    # ------------------------------------------------------------------
    # 单个 bug 处理
    # ------------------------------------------------------------------
    def _resolve_repo(self, bug: Bug) -> Optional[RepoConfig]:
        ws = self._workspace_of(bug)
        repos = ws.repos
        if not repos:
            return None
        if len(repos) == 1:
            return repos[0]
        if ws.default_repo:
            for r in repos:
                if r.name == ws.default_repo:
                    return r
        mod = (bug.module or "").lower()
        for r in repos:
            if r.name.lower() in mod or mod in r.name.lower():
                return r
        self.store.add_event(
            f"仓库映射未精确匹配，使用第一个仓库 {repos[0].name}", "warn", bug.id
        )
        return repos[0]

    def _llm_review(self, p4: P4Client, bug: Bug) -> None:
        diff = p4.diff_unified()
        if not diff.strip():
            return
        from .agents import ClaudeCLI
        from .agents.base import extract_final_json

        prompt = (
            f"请审查以下针对 Tapd Bug 的代码改动，判断：1) 是否确实针对该 bug；"
            f"2) 是否修改了无关范围；3) 是否有明显错误。\n"
            f"Bug 标题: {bug.title}\nBug 描述: {truncate(bug.description, 1000)}\n改动 diff:\n{diff[:8000]}\n"
            '只输出一行: FINAL_RESULT: {"approved": true 或 false, "note": "中文说明"}'
        )
        result = ClaudeCLI().run(prompt, p4.path, timeout_s=300)
        data = extract_final_json(result.raw_output or result.log)
        if data is not None and data.get("approved") is False:
            raise verify.VerificationError(
                "LLM 复核未通过: " + str(data.get("note") or "")
            )

    def process_bug(self, bug: Bug) -> None:
        self.store.upsert_job(bug, agent_state="in_progress", started_at=_now())
        self.store.add_event(f"开始处理 bug {bug.id}: {bug.title}", bug_id=bug.id)
        try:
            repo = self._resolve_repo(bug)
            if not repo:
                raise RuntimeError("未配置该 bug 对应的仓库映射（workspaces[].repos[]）")

            p4 = P4Client(repo.path, self.config.p4)
            p4.sync()
            self.store.add_event("p4 sync 完成", bug_id=bug.id)

            agent = build_agent(repo.agent, self.config)
            prompt = build_fix_prompt(bug, repo.name, repo.path, repo.test_cmd)
            self.store.add_event(f"调用编码 Agent（{repo.agent}）", bug_id=bug.id)
            result = agent.run(prompt, repo.path, timeout_s=self.config.agent_timeout_s)
            if result.manual_assets:
                self.store.add_event(
                    f"识别到需人工处理资源 {len(result.manual_assets)} 项", bug_id=bug.id
                )

            # ---- 验证门 ----
            opened: list[dict] = []
            test_out = ""
            if result.has_code_changes:
                opened = verify.check_and_prepare_p4(p4)
                if self.config.llm_review:
                    self._llm_review(p4, bug)
                test_ok, test_out = verify.run_tests(repo.path, repo.test_cmd)
                if not test_ok:
                    raise RuntimeError("测试未通过: " + test_out[-400:])
            if not result.has_code_changes and not result.has_manual_assets:
                reason = "; ".join(result.blocked_reasons) or result.log[:300] or "无输出"
                raise RuntimeError("Agent 未产出任何代码改动或资源说明: " + reason)

            # ---- 分类 ----
            if result.has_code_changes:
                state = "partial" if result.has_manual_assets else "resolved"
            else:
                state = "manual_only"

            # ---- 生成 pending changelist ----
            files = [o["depot"] for o in opened]
            desc = descgen.build_description(
                bug,
                result,
                test_out,
                changelist_extra=[
                    "本 changelist 由 TapdBugFixAgent 自动生成，请人工 review 后提交"
                ],
            )
            cl: Optional[int] = None
            if state in ("resolved", "partial"):
                cl = p4.create_pending(desc)
                self.store.add_event(f"已创建 pending changelist {cl}", bug_id=bug.id)

            self.store.update_job(
                bug.id,
                agent_state=state,
                changelist=cl,
                generated_description=desc,
                files=dumps(files),
                manual_assets=dumps(result.manual_assets),
                agent=repo.agent,
                failure_reason=None,
                finished_at=_now(),
            )

            # ---- Tapd 回写 ----
            self._notify_tapd(bug, state, cl, result)
            self.store.add_event(
                f"完成（{state}）" + (f"，changelist {cl}" if cl else ""), bug_id=bug.id
            )
        except Exception as exc:
            self._handle_failure(bug, exc)

    def _notify_tapd(
        self, bug: Bug, state: str, cl: Optional[int], result: AgentResult
    ) -> None:
        ws = self._workspace_of(bug)
        client = self._tapd(ws)
        lines = ["[TapdBugFixAgent] 自动修复完成。"]
        if state == "resolved":
            lines.append("状态: 已解决（代码已修复并验证）")
        elif state == "partial":
            lines.append("状态: 部分完成（代码已修复，部分资源需人工处理）")
        elif state == "manual_only":
            lines.append("状态: 该单为资源类修改，需人工处理（无代码改动）")
        if cl:
            lines.append(f"Perforce pending changelist: {cl}")
        if result.manual_assets:
            lines.append("需人工处理的资源:")
            for a in result.manual_assets:
                path = a.get("path", "?")
                reason = a.get("reason", "")
                lines.append(f"- {path}" + (f"  原因: {reason}" if reason else ""))
        lines.append("修复说明: " + (result.summary or "(无)"))
        try:
            client.add_comment(bug.id, "\n".join(lines))
            if state in ("resolved", "partial") and ws.comment_status:
                client.update_bug(bug.id, status=ws.comment_status)
            self.store.add_event(
                "已回写 Tapd 评论"
                + (f"，状态 -> {ws.comment_status}" if state in ("resolved", "partial") else ""),
                bug_id=bug.id,
            )
        except Exception as exc:
            self.store.add_event(f"回写 Tapd 失败: {exc}", "error", bug.id)

    def _handle_failure(self, bug: Bug, exc: Exception) -> None:
        job = self.store.get_job(bug.id) or {}
        attempts = int(job.get("attempts") or 0) + 1
        prev_state = job.get("agent_state")
        self.store.update_job(
            bug.id,
            agent_state="failed",
            failure_reason=str(exc)[:1000],
            attempts=attempts,
            finished_at=_now(),
        )
        self.store.add_event(f"处理失败: {exc}", "error", bug.id)
        # 首次失败才发 Tapd 评论，避免重复失败刷屏
        if prev_state == "failed":
            self.store.add_event("（已处于 failed，跳过重复失败评论）", bug_id=bug.id)
            return
        try:
            ws = self._workspace_of(bug)
            self._tapd(ws).add_comment(
                bug.id, f"[TapdBugFixAgent] 自动修复失败：\n{str(exc)[:800]}"
            )
        except Exception as exc2:
            self.store.add_event(f"回写 Tapd 失败评论出错: {exc2}", "error", bug.id)

    # ------------------------------------------------------------------
    # 人工操作（web）
    # ------------------------------------------------------------------
    def retry_bug(self, bug_id: int) -> bool:
        job = self.store.get_job(bug_id)
        if not job:
            return False
        self.store.update_job(
            bug_id,
            agent_state="pending",
            attempts=0,
            failure_reason=None,
            changelist=None,
            generated_description=None,
            files=None,
            manual_assets=None,
            finished_at=None,
        )
        self.store.add_event(f"人工触发重试 bug {bug_id}", bug_id=bug_id)
        return True

    def skip_bug(self, bug_id: int) -> bool:
        job = self.store.get_job(bug_id)
        if not job:
            return False
        self.store.update_job(bug_id, agent_state="skipped", finished_at=_now())
        self.store.add_event(f"人工跳过 bug {bug_id}", bug_id=bug_id)
        return True

    def status(self) -> dict:
        return {
            "control": self.state,
            "current_bug": self.current_bug_id,
            "jobs_total": self.store.job_count(),
            "queued": self.store.queued_count(),
            "counts": self.store.job_state_counts(),
        }
