"""编排工作线程：受控循环 + 分类（resolved/partial/manual_only/failed）+ Tapd 回写。"""
from __future__ import annotations

import threading
import time
from typing import Optional

from . import descgen, verify
from .agents import build_agent, build_fix_prompt
from .agents.base import AgentCancelledError
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
        self._cancel = threading.Event()  # 暂停/关闭时置位，中断当前 agent 运行
        self._clients: dict[str, TapdClient] = {}
        self._last_fetch = 0.0
        self._last_fetch_result: Optional[list[Bug]] = None

    # ------------------------------------------------------------------
    # 控制 API（web 调用）
    # ------------------------------------------------------------------
    def start(self) -> str:
        self._cancel.clear()
        self.store.set_control("running")
        self.store.add_event("已开启自动处理")
        self._wake.set()
        return self.state

    def pause(self) -> str:
        self._cancel.set()  # 中断正在跑的 agent（若有），下轮循环停在 paused
        self.store.set_control("paused")
        self.store.add_event("已暂停（当前 bug 处理被中断，恢复后回到队列）")
        return self.state

    def resume(self) -> str:
        return self.start()

    def stop(self) -> str:
        self._cancel.set()  # 中断正在跑的 agent（若有）
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

            # 处理开始时就把 agent / 模型写进 job，web 列表与详情可实时看到
            settings = self.config.agents.get(repo.agent)
            model = (settings.model if settings else None) or ""
            self.store.update_job(bug.id, agent=repo.agent, model=model)

            p4 = P4Client(repo.path, self.config.p4)
            p4.sync()
            self.store.add_event("p4 sync 完成", bug_id=bug.id)

            agent = build_agent(repo.agent, self.config)
            prompt = build_fix_prompt(bug, repo.name, repo.path, repo.test_cmd)
            self.store.add_event(f"调用编码 Agent（{repo.agent}）", bug_id=bug.id)
            result = agent.run(
                prompt,
                repo.path,
                timeout_s=self.config.agent_timeout_s,
                on_progress=lambda msg: self.store.add_event(
                    msg, level="debug", bug_id=bug.id
                ),
                cancel_event=self._cancel,
            )
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
        except AgentCancelledError:
            # 人工暂停/关闭：回到待处理队列（可重试），不算失败，不回写 Tapd
            self.store.update_job(
                bug.id,
                agent_state="pending",
                failure_reason=None,
                finished_at=None,
            )
            self.store.add_event(
                "处理被人工中断（暂停/关闭），bug 回到待处理队列", "warn", bug.id
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
    # Web 展示（合并 Tapd 实时 bug 与本地处理状态）
    # ------------------------------------------------------------------
    def _job_row(self, bug: Bug, include_desc: bool = False) -> dict:
        """把 Tapd bug 与本地 job 合并成管理台列表行（未处理 bug 也列出）。"""
        job = self.store.get_job(bug.id) or {}
        item = {
            "bug_id": str(bug.id),  # 大整数（>2^53）跨 JSON 会丢精度，必须字符串传输
            "workspace_id": bug.workspace_id,
            "title": bug.title,
            "priority": bug.priority,
            "priority_label": bug.priority_label,
            "severity": bug.severity,
            "module": bug.module,
            "tapd_status": bug.status,
            "created_at": bug.created,
            "url": bug.url,
            "agent_state": job.get("agent_state"),
            "changelist": job.get("changelist"),
            "agent": job.get("agent"),
            "model": job.get("model"),
            "started_at": job.get("started_at"),
            "finished_at": job.get("finished_at"),
            "failure_reason": job.get("failure_reason"),
            "attempts": job.get("attempts") or 0,
            "has_local": bool(job),
        }
        if include_desc:
            item["description"] = bug.description
        return item

    def list_bugs_for_web(self) -> list[dict]:
        """管理台列表：Tapd 上分配给我的有效 bug + 本地处理状态，按优先级排序。

        排除 exclude_status（resolved/closed/rejected）；未处理（无本地记录）的
        bug 也列出，agent_state 为空，供前端显示为「未处理」。
        """
        ranked = []
        for b in self._fetch_my_bugs():
            if b.status in self.config.exclude_status:
                continue
            row = self._job_row(b)
            row["_rank"] = self.config.priority_rank(b)
            ranked.append(row)
        ranked.sort(key=lambda r: (r["_rank"], r["created_at"] or ""))
        for r in ranked:
            r.pop("_rank", None)
        return ranked

    def bug_detail_for_web(self, bug_id: int) -> Optional[dict]:
        """管理台详情：合并 Tapd 实时字段与本地处理记录；未处理也能查看。

        返回 None 表示 Tapd 与本地都没有该 bug。
        """
        bug = self._fetch_bug_for_manual(bug_id)
        job = self.store.get_job(bug_id)
        if bug is None and job is None:
            return None
        detail = self._job_row(bug, include_desc=True) if bug else {}
        if job:
            detail.update(job)  # 本地处理字段优先（files 等保持 JSON 字符串，前端自行 parse）
            # 拆分：debug 级是 Agent 实时进度（stream-json 逐行动作），单独给前端做醒目的进度区
            all_events = self.store.list_events(bug_id, limit=300)
            detail["progress"] = [e for e in all_events if e["level"] == "debug"]
            detail["events"] = [e for e in all_events if e["level"] != "debug"]
        else:
            detail["files"] = "[]"
            detail["manual_assets"] = "[]"
            detail["events"] = []
            detail["progress"] = []
            detail["generated_description"] = ""
        detail["bug_id"] = str(detail.get("bug_id"))  # 保证字符串（job 覆盖后可能是 int）
        return detail

    # ------------------------------------------------------------------
    # 人工操作（web）
    # ------------------------------------------------------------------
    def _fetch_bug_for_manual(self, bug_id: int) -> Optional[Bug]:
        """人工操作按 id 取 bug：先在「分配给我」列表找，再按 id 直拉。

        未处理 bug 在管理台也能查看/跳过，但这些操作需要 bug 的标题等
        字段才能落本地记录，所以没有本地 job 时要能从 Tapd 拿到它。
        """
        bug = next((b for b in self._fetch_my_bugs() if b.id == bug_id), None)
        if bug is None:
            try:
                ws = self.config.workspaces[0]
                bug = self._tapd(ws).get_bug(bug_id)
            except Exception:
                bug = None
        return bug

    def retry_bug(self, bug_id: int) -> bool:
        job = self.store.get_job(bug_id)
        if not job:
            # 未处理 bug「重试」= 确保可被处理（它本来就在队列里），幂等成功
            if self._fetch_bug_for_manual(bug_id) is None:
                return False
            self.store.add_event(f"人工触发处理 bug {bug_id}", bug_id=bug_id)
            return True
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
            # 未处理 bug：建一条 skipped 记录，worker 就不会再抓它
            bug = self._fetch_bug_for_manual(bug_id)
            if bug is None:
                return False
            self.store.upsert_job(bug, agent_state="skipped", finished_at=_now())
            self.store.add_event(f"人工跳过 bug {bug_id}（未处理，不再自动处理）", bug_id=bug_id)
            return True
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
