"""验证门：确认 Agent 改动被 p4 正确记录 + 测试通过。

流程：
1. p4 opened 非空（Agent 确实开了文件）
2. p4 reconcile -n 兜底：若 Agent 改了文件却没 p4 edit，自动 reconcile 打开，防止改动丢失
3. 运行仓库测试命令
"""
from __future__ import annotations

import subprocess

from .p4util import P4Client


class VerificationError(RuntimeError):
    pass


def check_and_prepare_p4(p4: P4Client) -> list[dict]:
    """确保 Agent 的改动都在 p4 中打开，返回 opened 列表。"""
    opened = p4.opened()
    if not opened:
        raise VerificationError("Agent 未打开任何文件（未产生改动，或遗漏 p4 edit）")

    preview = p4.reconcile_preview()
    if preview.strip():
        p4.reconcile()
        opened = p4.opened()
        if not opened:
            raise VerificationError("reconcile 后仍无 opened 文件")

    return opened


def run_tests(
    repo_path: str, test_cmd: str, timeout: int = 600
) -> tuple[bool, str]:
    """运行测试命令，返回 (是否通过, 输出尾部)。未配置测试命令视为通过。"""
    if not test_cmd or not test_cmd.strip():
        return True, "(未配置测试命令，跳过)"
    try:
        proc = subprocess.run(
            test_cmd,
            shell=True,
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"测试超时({timeout}s)"
    except OSError as exc:
        return False, f"无法运行测试命令: {exc}"
    output = ((proc.stdout or "") + (proc.stderr or ""))[-1500:]
    return proc.returncode == 0, output
