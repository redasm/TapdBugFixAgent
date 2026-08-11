"""Claude CLI 适配器：headless 模式，stream-json 输出 + 实时进度。

用 `--output-format stream-json --verbose` 让 claude 把 assistant 事件逐行流出来
（含 tool_use / text 块），借此把 Agent 的每一步动作实时回调给编排器写进
数据库事件，Web 管理台就能看到"正在读哪个文件/在搜索什么"，而不是静默等待。
结束时从 `result` 事件取最终文本，走统一的 FINAL_RESULT 解析。
"""
from __future__ import annotations

import json
import threading
from typing import Optional

from ..config import AgentSettings
from ..models import AgentResult
from .base import AgentCancelledError, result_from_output, run_cli_streaming

_DEFAULT_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]


def progress_from_line(line: str) -> Optional[str]:
    """把一条 stream-json 行转成人类可读的进度消息；无关行返回 None。"""
    line = line.strip()
    if not line:
        return None
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        return None
    if d.get("type") != "assistant":
        return None
    content = (d.get("message") or {}).get("content") or []
    for c in content:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "tool_use":
            inp = c.get("input") or {}
            target = (
                inp.get("file_path")
                or inp.get("pattern")
                or inp.get("path")
                or inp.get("command")
                or ""
            )
            return f"Agent: {c.get('name')} {str(target)[:120]}"
        if c.get("type") == "text":
            txt = str(c.get("text") or "").strip()
            if txt:
                return f"Agent: {txt[:160]}"
    return None


def _extract_result_text(stdout: str) -> str:
    """从 stream-json 输出里取最后 result 事件的最终文本。"""
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") == "result" and isinstance(d.get("result"), str):
            return d["result"]
    return ""


class ClaudeCLI:
    def __init__(self, settings: Optional[AgentSettings] = None):
        self.settings = settings or AgentSettings()

    def run(
        self,
        prompt: str,
        repo_dir: str,
        timeout_s: int = 900,
        on_progress: Optional[callable] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> AgentResult:
        # prompt 通过 stdin 传入，避免 Windows cmd 命令行对多行/引号/反斜杠的破坏
        cmd = [
            "claude",
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--allowedTools",
            ",".join(self.settings.allowed_tools or _DEFAULT_TOOLS),
            "--permission-mode",
            self.settings.permission_mode or "acceptEdits",
        ]
        if self.settings.model:
            cmd += ["--model", self.settings.model]

        def _on_line(line: str) -> None:
            if not on_progress:
                return
            msg = progress_from_line(line)
            if msg:
                on_progress(msg)

        try:
            proc = run_cli_streaming(
                cmd, cwd=repo_dir, timeout_s=timeout_s,
                input_text=prompt, on_progress=_on_line,
                cancel_event=cancel_event,
            )
        except AgentCancelledError:
            raise  # 人工取消：交给 worker 特殊处理，不当作失败
        except Exception as exc:
            ar = AgentResult.from_failure(-1, str(exc))
            ar.log = str(exc)
            return ar

        final_text = _extract_result_text(proc.stdout or "")
        ar = result_from_output(final_text, proc.returncode)
        ar.log = (
            (proc.stderr or "")[-1000:] + "\n" + (final_text or "")[-2500:]
        ).strip()
        return ar
