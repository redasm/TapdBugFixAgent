"""Agent 适配基础：子进程执行 + prompt 模板 + 结构化输出解析。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from typing import Any, Optional

from ..models import AgentResult, Bug, truncate


class AgentRuntimeError(RuntimeError):
    pass


FINAL_MARKER = "FINAL_RESULT:"


# ---------------------------------------------------------------------------
# 子进程执行（Windows 上用 shell=True 以支持 claude.cmd / codex.cmd 等 shim）
# ---------------------------------------------------------------------------
def run_cli(
    cmd: list[str],
    cwd: str,
    timeout_s: int = 900,
    input_text: Optional[str] = None,
) -> subprocess.CompletedProcess:
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "capture_output": True,
        "text": True,
        "timeout": timeout_s,
        "input": input_text,
    }
    if os.name == "nt":
        kwargs["shell"] = True  # Windows: 由 cmd.exe 解析，才能执行 .cmd/.bat shim
    else:
        kwargs["shell"] = False
    try:
        return subprocess.run(cmd, **kwargs)
    except subprocess.TimeoutExpired as exc:
        raise AgentRuntimeError(f"Agent 调用超时({timeout_s}s): {cmd[0]}") from exc
    except OSError as exc:
        raise AgentRuntimeError(f"无法执行 {cmd[0]}: {exc}") from exc


# ---------------------------------------------------------------------------
# 结构化输出解析
# ---------------------------------------------------------------------------
def _strip_code_fence(seg: str) -> str:
    seg = seg.strip()
    if seg.startswith("```"):
        seg = seg.split("\n", 1)[-1]
    if seg.rstrip().endswith("```"):
        seg = seg.rsplit("\n", 1)[0]
    return seg.strip()


def extract_final_json(text: str) -> Optional[dict]:
    """从 Agent 输出中提取最后的 FINAL_RESULT JSON（或最后一个 json 代码块）。"""
    if not text:
        return None
    idx = text.rfind(FINAL_MARKER)
    if idx != -1:
        seg = _strip_code_fence(text[idx + len(FINAL_MARKER):])
        try:
            obj = json.loads(seg)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    for block in reversed(re.findall(r"```(?:json)?\s*(.*?)```", text, flags=re.S)):
        try:
            obj = json.loads(block.strip())
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def result_from_output(text: str, exit_code: int) -> AgentResult:
    data = extract_final_json(text)
    ar = AgentResult(ok=(exit_code == 0), exit_code=exit_code, raw_output=(text or "")[:8000])
    if data:
        ar.ok = True
        ar.summary = str(data.get("summary") or "")
        ar.changed_files = [str(f) for f in (data.get("changed_files") or [])]
        ar.manual_assets = [dict(a) for a in (data.get("manual_assets") or [])]
        ar.blocked_reasons = [str(r) for r in (data.get("blocked_reasons") or [])]
    elif exit_code == 0 and (text or "").strip():
        ar.summary = (text or "").strip()[-2000:]
    return ar


# ---------------------------------------------------------------------------
# prompt 模板
# ---------------------------------------------------------------------------
def build_fix_prompt(bug: Bug, repo_name: str, repo_path: str, test_cmd: str) -> str:
    desc = truncate(bug.description, 2000).strip()
    if not desc:
        desc = "（该 Bug 无描述文本）"
    return f"""你是自动修复 Tapd Bug 的编码 Agent。请修复下面的 Bug。

# Bug 信息
标题: {bug.title}
优先级: {bug.priority_label or bug.priority}
模块: {bug.module}
TAPD 单号: {bug.id}
描述:
{desc}

# 工作区规则（Perforce）
1. 修改任何已有文件前，先执行: p4 edit <文件>
2. 新建文件后执行: p4 add <文件>
3. 禁止使用: p4 submit / p4 revert / p4 sync / p4 change
4. 只把改动放进 default changelist。
5. 涉及 prefab / 场景 / 图集 / 表格(xlsx/csv/bytes) / 其他二进制资源时，不要强行修改；把它们列入「需人工处理资源」清单并说明原因。
6. 完成后不要提交。

# 定位要求
- 如果仅凭标题/模块无法在代码中定位问题，或缺少关键信息（如复现步骤、日志），**不要臆测硬改**；把缺什么写进 blocked_reasons 并停止。
- 优先在代码里搜索标题/模块相关的关键词来定位。

# 仓库
名称: {repo_name}
路径: {repo_path}
测试命令: {test_cmd or "(无)"}
修改后请尽量运行测试确认。

# 输出要求（重要）
结束时，在最后输出一行（可放在 json 代码块里），严格使用以下格式：
FINAL_RESULT:
```json
{{"summary": "修复说明（中文，简述改动与验证结果）", "changed_files": ["相对仓库路径的文件"], "manual_assets": [{{"path": "需人工处理的资源路径", "reason": "原因"}}], "blocked_reasons": ["无法完成/缺少信息的原因"]}}
```"""


def build_agent(name: str, config) -> Any:
    """根据配置构建 Agent 实例。"""
    from ..config import AgentSettings
    from .claude_cli import ClaudeCLI
    from .codex_cli import CodexCLI
    from .command import CommandAgent

    settings = config.agents.get(name) or AgentSettings()
    if name == "claude":
        return ClaudeCLI(settings)
    if name == "codex":
        return CodexCLI(settings)
    if name == "command":
        if not settings.template:
            raise AgentRuntimeError("agent 'command' 未配置 template（agents.command.template）")
        return CommandAgent(settings.template)
    raise AgentRuntimeError(f"未知 agent: {name!r}（可用 claude / codex / command）")
