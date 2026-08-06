"""Codex CLI 适配器（OpenAI Codex CLI）：codex exec 无审批模式。"""
from __future__ import annotations

from typing import Optional

from ..config import AgentSettings
from ..models import AgentResult
from .base import result_from_output, run_cli


class CodexCLI:
    def __init__(self, settings: Optional[AgentSettings] = None):
        self.settings = settings or AgentSettings()

    def run(self, prompt: str, repo_dir: str, timeout_s: int = 900) -> AgentResult:
        cmd = [
            "codex",
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
        ]
        if self.settings.model:
            cmd += ["--model", self.settings.model]  # 可选模型覆盖，留空用 CLI 默认
        cmd.append(prompt)
        try:
            proc = run_cli(cmd, cwd=repo_dir, timeout_s=timeout_s)
        except Exception as exc:
            ar = AgentResult.from_failure(-1, str(exc))
            ar.log = str(exc)
            return ar

        text = proc.stdout or ""
        ar = result_from_output(text, proc.returncode)
        ar.log = ((proc.stderr or "")[-1000:] + "\n" + text[-2500:]).strip()
        return ar
