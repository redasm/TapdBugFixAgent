"""p4 (Perforce) 命令封装。

所有操作限定在指定的 client workspace 内，通过子进程 env 注入 P4PORT/P4CLIENT/P4USER/P4PASSWD。
安全约定：本模块只提供 sync / opened / diff / reconcile / revert / change 相关操作；
submit 仅由 auto 模式显式调用。revert / submit / sync 也禁止出现在 Agent 的 prompt 里。
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

# config.p4 键 -> 环境变量名
_P4_ENV_MAP = {
    "port": "P4PORT",
    "client": "P4CLIENT",
    "user": "P4USER",
    "password": "P4PASSWD",
    "config": "P4CONFIG",
}

_OPENED_RE = re.compile(r"^(\S+)\s+#\S+\s+-\s+(\S+)\s+(?:default|change\s+(\d+))\s*\(([^)]*)\)")
_CHANGE_CREATED_RE = re.compile(r"Change\s+(\d+)\s+created", re.IGNORECASE)


class P4Error(RuntimeError):
    pass


def set_spec_field(spec: str, field: str, value: str) -> str:
    """在 p4 change spec 文本中替换某个多行字段（如 Description）。"""
    lines = spec.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(field + ":"):
            out.append(field + ":")
            for vl in value.splitlines():
                out.append("\t" + vl if vl else "\t")
            i += 1
            while i < len(lines) and (lines[i].startswith("\t") or lines[i].startswith(" ")):
                i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out) + "\n"


class P4Client:
    def __init__(self, workspace_path: str, config_p4: Optional[dict] = None):
        self.path = str(workspace_path)
        self.env = os.environ.copy()
        cfg = config_p4 or {}
        for key, env_name in _P4_ENV_MAP.items():
            val = cfg.get(key)
            if val:
                self.env[env_name] = str(val)

    def run(self, args: list[str], input_text: Optional[str] = None, timeout: int = 120) -> str:
        cmd = ["p4", *args]
        try:
            proc = subprocess.run(
                cmd,
                cwd=self.path,
                env=self.env,
                input=input_text,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise P4Error(f"p4 {' '.join(args)} 超时({timeout}s)") from exc
        if proc.returncode != 0:
            err = (proc.stderr or "").strip() or (proc.stdout or "").strip() or "p4 failed"
            raise P4Error(f"p4 {' '.join(args)} 失败: {err}")
        return proc.stdout

    # ---------- 只读 ----------
    def sync(self, timeout: int = 600) -> str:
        return self.run(["sync"], timeout=timeout)

    def opened(self) -> list[dict]:
        """返回打开的文件列表：[{depot, action, changelist, type}]"""
        try:
            out = self.run(["opened"])
        except P4Error:
            return []
        result = []
        for line in out.splitlines():
            m = _OPENED_RE.match(line)
            if m:
                result.append(
                    {
                        "depot": m.group(1),
                        "action": m.group(2),
                        "changelist": m.group(3) or "default",
                        "type": m.group(4),
                    }
                )
        return result

    def diff_unified(self) -> str:
        """default changelist 内改动的 unified diff。"""
        try:
            return self.run(["diff", "-du"])
        except P4Error:
            return ""

    def reconcile_preview(self) -> str:
        """检测"改了文件但没 p4 edit/p4 add"的磁盘差异（-n 预览）。"""
        try:
            return self.run(["reconcile", "-n"])
        except P4Error:
            return ""

    # ---------- 写操作（编排器专用）----------
    def reconcile(self) -> str:
        return self.run(["reconcile"])

    def revert(self, files: list[str]) -> str:
        if not files:
            return ""
        return self.run(["revert", *files])

    def change_spec(self, cl: Optional[int] = None) -> str:
        args = ["change", "-o"]
        if cl is not None:
            args.append(str(cl))
        return self.run(args)

    def create_pending(self, description: str) -> int:
        """创建新的 pending changelist（含当前 default 中所有 opened 文件），返回编号。

        标准做法：p4 change -o（其 Files 段含已打开文件）改描述后 p4 change -i。
        """
        spec = self.change_spec()
        spec = set_spec_field(spec, "Description", description)
        out = self.run(["change", "-i"], input_text=spec)
        m = _CHANGE_CREATED_RE.search(out)
        if not m:
            raise P4Error(f"无法解析创建 changelist 的输出: {out.strip()[:300]}")
        return int(m.group(1))

    def update_description(self, cl: int, description: str) -> None:
        spec = self.change_spec(cl)
        spec = set_spec_field(spec, "Description", description)
        self.run(["change", "-i"], input_text=spec)

    def submit(self, cl: int, description: str) -> str:
        """仅 auto 模式调用：提交 pending changelist。"""
        return self.run(["submit", "-d", description, str(cl)], timeout=600)
