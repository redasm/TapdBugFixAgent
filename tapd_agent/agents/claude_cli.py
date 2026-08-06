"""Claude CLI 适配器：headless 模式（claude -p ... --output-format json）。"""
from __future__ import annotations

import json
import os
from typing import Optional

from ..config import AgentSettings
from ..models import AgentResult
from .base import result_from_output, run_cli


class ClaudeCLI:
    def __init__(self, settings: Optional[AgentSettings] = None):
        self.settings = settings or AgentSettings()

    def run(self, prompt: str, repo_dir: str, timeout_s: int = 900) -> AgentResult:
        # prompt 通过 stdin 传入，避免 Windows cmd 命令行对多行/引号/反斜杠的破坏
        cmd = [
            "claude",
            "-p",
            "--output-format",
            "json",
            "--allowedTools",
            ",".join(self.settings.allowed_tools or ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]),
            "--permission-mode",
            self.settings.permission_mode or "acceptEdits",
        ]
        if self.settings.model:
            cmd += ["--model", self.settings.model]

        try:
            proc = run_cli(cmd, cwd=repo_dir, timeout_s=timeout_s, input_text=prompt)
        except Exception as exc:
            ar = AgentResult.from_failure(-1, str(exc))
            ar.log = str(exc)
            return ar

        text = proc.stdout or ""
        result_text = text
        try:
            obj = json.loads(text)
            if isinstance(obj, dict) and "result" in obj:
                result_text = obj["result"] or ""
        except json.JSONDecodeError:
            pass

        ar = result_from_output(result_text, proc.returncode)
        ar.log = ((proc.stderr or "")[-1000:] + "\n" + text[-2500:]).strip()
        return ar
