"""Agent 适配基础：子进程执行 + prompt 模板 + 结构化输出解析。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from typing import Any, Optional

from ..models import AgentResult, Bug, truncate


class AgentRuntimeError(RuntimeError):
    pass


class AgentCancelledError(AgentRuntimeError):
    """agent 运行被人工取消（web 暂停/关闭）——不是失败，需要特殊处理。"""
    pass


FINAL_MARKER = "FINAL_RESULT:"


# ---------------------------------------------------------------------------
# 子进程执行（Windows 上用 shell=True 以支持 claude.cmd / codex.cmd 等 shim）
# ---------------------------------------------------------------------------
def _kill_process_tree(proc: subprocess.Popen) -> None:
    """超时后杀掉整棵进程树。

    Windows + shell=True 时直接 proc.kill() 只会杀掉 cmd.exe 壳，真正的
    编码 Agent（node/claude）会变孤儿进程继续运行，持续占用 p4 文件锁、
    拖慢机器。必须用 taskkill /T 递归杀。
    """
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        proc.kill()
    except OSError:
        pass


def run_cli(
    cmd: list[str],
    cwd: str,
    timeout_s: int = 3600,
    input_text: Optional[str] = None,
    cancel_event: Optional[threading.Event] = None,
) -> subprocess.CompletedProcess:
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
    }
    if os.name == "nt":
        kwargs["shell"] = True  # Windows: 由 cmd.exe 解析，才能执行 .cmd/.bat shim
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["shell"] = False
    try:
        proc = subprocess.Popen(cmd, **kwargs)
    except OSError as exc:
        raise AgentRuntimeError(f"无法执行 {cmd[0]}: {exc}") from exc
    if cancel_event is not None:
        # 看门狗线程：cancel 置位时立刻杀进程树（communicate 会被打断返回）。
        def _watchdog() -> None:
            while proc.poll() is None:
                if cancel_event.is_set():
                    _kill_process_tree(proc)
                    return
                time.sleep(0.2)

        threading.Thread(target=_watchdog, daemon=True).start()
    try:
        stdout, stderr = proc.communicate(input=input_text, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        _kill_process_tree(proc)
        raise AgentRuntimeError(f"Agent 调用超时({timeout_s}s): {cmd[0]}") from None
    if cancel_event is not None and cancel_event.is_set():
        raise AgentCancelledError(f"Agent 调用被人工取消: {cmd[0]}")
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def run_cli_streaming(
    cmd: list[str],
    cwd: str,
    timeout_s: int = 3600,
    input_text: Optional[str] = None,
    on_progress: Optional[Any] = None,
    cancel_event: Optional[threading.Event] = None,
) -> subprocess.CompletedProcess:
    """流式执行：stdout 逐行回调 on_progress(line) 用于实时进度展示。

    与 run_cli 的差异：不等到进程结束才拿输出，而是边跑边把每行交给回调
    （Agent 的 stream-json 模式用它把"正在读哪个文件/搜索什么"实时报出去），
    同时仍累计完整 stdout/stderr。超时同样杀整棵进程树防孤儿；
    cancel_event 置位时立即取消（web 暂停/关闭）。
    """
    import threading

    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
    }
    if os.name == "nt":
        kwargs["shell"] = True
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["shell"] = False
    try:
        proc = subprocess.Popen(cmd, **kwargs)
    except OSError as exc:
        raise AgentRuntimeError(f"无法执行 {cmd[0]}: {exc}") from exc

    out_chunks: list[str] = []
    err_chunks: list[str] = []

    def _drain(pipe: Any, sink: list[str], progress: Optional[Any]) -> None:
        assert pipe is not None
        for line in pipe:
            sink.append(line)
            if progress is not None:
                try:
                    progress(line)
                except Exception:
                    pass  # 进度回调失败不影响主流程
        try:
            pipe.close()
        except OSError:
            pass

    threads = [
        threading.Thread(target=_drain, args=(proc.stdout, out_chunks, on_progress), daemon=True),
        threading.Thread(target=_drain, args=(proc.stderr, err_chunks, None), daemon=True),
    ]
    for t in threads:
        t.start()
    try:
        assert proc.stdin is not None
        proc.stdin.write(input_text or "")
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    deadline = time.monotonic() + timeout_s
    while True:
        if cancel_event is not None and cancel_event.is_set():
            _kill_process_tree(proc)
            raise AgentCancelledError(f"Agent 调用被人工取消: {cmd[0]}") from None
        if proc.poll() is not None:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            _kill_process_tree(proc)
            raise AgentRuntimeError(f"Agent 调用超时({timeout_s}s): {cmd[0]}") from None
        try:
            proc.wait(timeout=min(0.2, remaining))
        except subprocess.TimeoutExpired:
            continue  # 每 0.2s 回来检查一次 cancel/超时
    for t in threads:
        t.join(timeout=5)
    return subprocess.CompletedProcess(
        cmd, proc.returncode, "".join(out_chunks), "".join(err_chunks)
    )


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
