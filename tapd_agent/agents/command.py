"""通用命令 Agent：用一段 shell 命令模板接入任意 Agent CLI。

模板形如（config.yaml agents.command.template）：
  my-agent --dir {repo} --task "{prompt}"
{prompt} / {repo} 会被替换。输出需含 FINAL_RESULT JSON（与 claude/codex 约定一致）。
"""
from __future__ import annotations

from ..models import AgentResult
from .base import result_from_output, run_cli


class CommandAgent:
    def __init__(self, template: str):
        self.template = template

    def run(self, prompt: str, repo_dir: str, timeout_s: int = 900) -> AgentResult:
        cmd = self.template.format(prompt=prompt, repo=repo_dir)
        try:
            proc = run_cli([cmd], cwd=repo_dir, timeout_s=timeout_s)
        except Exception as exc:
            ar = AgentResult.from_failure(-1, str(exc))
            ar.log = str(exc)
            return ar

        text = proc.stdout or ""
        ar = result_from_output(text, proc.returncode)
        ar.log = ((proc.stderr or "")[-1000:] + "\n" + text[-2500:]).strip()
        return ar
