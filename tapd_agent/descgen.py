"""pending changelist 描述生成：使用 Tapd bug 单信息 + Agent 结果。"""
from __future__ import annotations

from .models import AgentResult, Bug, truncate


def build_description(
    bug: Bug,
    result: AgentResult,
    test_output: str = "",
    changelist_extra: list[str] | None = None,
) -> str:
    """生成 p4 pending changelist 的 Description（多行文本）。"""
    lines: list[str] = []
    title = bug.title.strip() or f"修复 TAPD-{bug.id}"
    lines.append(f"[TAPD-{bug.id}] {title}")
    lines.append("")
    lines.append(f"TAPD 单号: bug_{bug.id}")
    lines.append(f"单子链接: {bug.url}")
    if bug.priority_label or bug.priority:
        lines.append(f"优先级: {bug.priority_label or bug.priority}")
    if bug.severity:
        lines.append(f"严重程度: {bug.severity}")
    if bug.module:
        lines.append(f"模块: {bug.module}")
    if bug.reporter:
        lines.append(f"报告人: {bug.reporter}")
    if bug.created:
        lines.append(f"创建时间: {bug.created}")
    lines.append("")
    lines.append("问题描述:")
    lines.append(truncate(bug.description, 800) or "(空)")

    lines.append("")
    lines.append("修复说明:")
    lines.append(result.summary.strip() or "(Agent 未提供摘要)")

    if result.changed_files:
        lines.append("")
        lines.append("修改文件:")
        for f in result.changed_files:
            lines.append(f"- {f}")

    if result.manual_assets:
        lines.append("")
        lines.append("需人工处理的资源:")
        for asset in result.manual_assets:
            path = asset.get("path") or "?"
            reason = asset.get("reason") or ""
            lines.append(f"- {path}" + (f"    原因: {reason}" if reason else ""))

    if changelist_extra:
        lines.append("")
        lines.append("补充:")
        for extra in changelist_extra:
            lines.append(f"- {extra}")

    if test_output:
        lines.append("")
        lines.append("验证:")
        lines.append(truncate(test_output, 500) or "(空)")

    return "\n".join(lines)
