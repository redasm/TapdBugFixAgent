"""核心数据模型。"""
from __future__ import annotations

import html as _html
import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t ]+")

_PRIORITY_LABEL = {
    "high": "高", "medium": "中", "low": "低",
    "urgent": "紧急", "1": "高", "2": "中", "3": "低",
}
_SEVERITY_LABEL = {
    "high": "高", "medium": "中", "low": "低",
    "normal": "一般", "serious": "严重", "urgent": "紧急",
    "fatal": "致命",
}


def strip_html(text: Any) -> str:
    """去掉 Tapd description 里的 HTML 标签并还原实体。"""
    text = _HTML_TAG_RE.sub(" ", str(text or ""))
    text = _html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def truncate(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…(截断)"


@dataclass
class Bug:
    """Tapd bug 单（已归一化的字段 + 原始字段）。"""

    id: int
    workspace_id: str
    title: str
    description: str
    status: str
    priority: str
    priority_label: str
    severity: str
    module: str
    current_owner: str
    reporter: str
    created: str
    raw: dict = field(default_factory=dict)

    @property
    def url(self) -> str:
        return (
            f"https://www.tapd.cn/{self.workspace_id}"
            f"/bugtrace/bugs/view?bug_id={self.id}"
        )

    @classmethod
    def from_dict(cls, d: dict, workspace_id: Any) -> "Bug":
        if not isinstance(d, dict):
            d = {}
        # 解 Tapd API 的 {"Bug": {...}} 实体包装
        if "id" not in d and "title" not in d:
            for v in d.values():
                if isinstance(v, dict) and ("id" in v or "title" in v):
                    d = v
                    break
        priority = str(d.get("priority") or "")
        raw_pl = str(d.get("priority_label") or "")
        # priority_label 可能是显示文本（"高"）也可能是码值（"medium"），统一转中文
        priority_label = _PRIORITY_LABEL.get(raw_pl) or raw_pl or _PRIORITY_LABEL.get(priority, "")
        severity_code = str(d.get("severity") or "")
        raw_sl = str(d.get("severity_label") or "")
        severity = _SEVERITY_LABEL.get(raw_sl) or raw_sl or _SEVERITY_LABEL.get(severity_code, severity_code)
        return cls(
            id=int(d.get("id") or 0),
            workspace_id=str(workspace_id),
            title=str(d.get("name") or d.get("title") or ""),
            description=strip_html(d.get("description")),
            status=str(d.get("status") or ""),
            priority=priority,
            priority_label=priority_label,
            severity=severity,
            module=str(d.get("module") or ""),
            current_owner=str(d.get("current_owner") or "").rstrip(";"),
            reporter=str(d.get("reporter") or ""),
            created=str(d.get("created") or ""),
            raw=d,
        )


@dataclass
class AgentResult:
    """编码 Agent 的一次运行结果（含结构化解析）。"""

    ok: bool
    summary: str = ""
    changed_files: list[str] = field(default_factory=list)
    manual_assets: list[dict] = field(default_factory=list)
    blocked_reasons: list[str] = field(default_factory=list)
    exit_code: int = -1
    log: str = ""
    raw_output: str = ""

    @property
    def has_code_changes(self) -> bool:
        return bool(self.changed_files)

    @property
    def has_manual_assets(self) -> bool:
        return bool(self.manual_assets)

    @classmethod
    def from_failure(cls, exit_code: int, log: str) -> "AgentResult":
        return cls(ok=False, exit_code=exit_code, log=log)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "summary": self.summary,
            "changed_files": self.changed_files,
            "manual_assets": self.manual_assets,
            "blocked_reasons": self.blocked_reasons,
            "exit_code": self.exit_code,
        }


def dumps(obj: Any) -> str:
    """JSON 序列化（供 SQLite 存储）。"""
    return json.dumps(obj, ensure_ascii=False, default=str)


def loads(text: Optional[str], default: Any) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return default
