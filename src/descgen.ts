/** pending changelist 描述生成：使用 Tapd bug 单信息 + Agent 结果。 */

import type { AgentResult, Bug } from "./models.js";
import { truncate } from "./models.js";

/** 提取 bug 短号（swarm 校验用的 b<短号>）。
 *  Tapd 完整 id 形如 1152729922·001257090 = "1" + workspace_id("52729922") + 前导零序号；
 *  团队惯用短号 = 序号去前导零（1257090）。前缀不匹配时回退取末 7 位去前导零。 */
export function bugShortId(bug: Pick<Bug, "id" | "workspace_id">): string {
  const id = String(bug.id ?? "");
  const prefix = "1" + String(bug.workspace_id ?? "");
  let serial = id.startsWith(prefix) ? id.slice(prefix.length) : id.slice(-7);
  serial = serial.replace(/^0+/, "");
  return serial || id; // 全零/异常时保底用完整 id
}

/** 生成 p4 pending changelist 的 Description（多行文本）。
 *  首行用团队 swarm 校验格式：【b<短号>】<标题>（完整单号保留在「TAPD 单号」行）。 */
export function buildDescription(
  bug: Bug,
  result: AgentResult,
  testOutput = "",
  changelistExtra: string[] = [],
): string {
  const lines: string[] = [];
  const title = bug.title.trim() || `修复 Bug ${bug.id}`;
  lines.push(`【b${bugShortId(bug)}】${title}`);
  lines.push("");
  lines.push(`TAPD 单号: bug_${bug.id}`);
  lines.push(`单子链接: ${bugUrl(bug.workspace_id, bug.id)}`);
  if (bug.priority_label || bug.priority) {
    lines.push(`优先级: ${bug.priority_label || bug.priority}`);
  }
  if (bug.severity) lines.push(`严重程度: ${bug.severity}`);
  if (bug.module) lines.push(`模块: ${bug.module}`);
  if (bug.reporter) lines.push(`报告人: ${bug.reporter}`);
  if (bug.created) lines.push(`创建时间: ${bug.created}`);
  lines.push("");
  lines.push("问题描述:");
  lines.push(truncate(bug.description, 800) || "(空)");

  lines.push("");
  lines.push("修复说明:");
  lines.push(result.summary.trim() || "(Agent 未提供摘要)");

  if (result.changed_files.length) {
    lines.push("");
    lines.push("修改文件:");
    for (const f of result.changed_files) lines.push(`- ${f}`);
  }

  if (result.manual_assets.length) {
    lines.push("");
    lines.push("需人工处理的资源:");
    for (const asset of result.manual_assets) {
      const path = asset.path || "?";
      const reason = asset.reason || "";
      lines.push(`- ${path}` + (reason ? `    原因: ${reason}` : ""));
    }
  }

  if (changelistExtra.length) {
    lines.push("");
    lines.push("补充:");
    for (const extra of changelistExtra) lines.push(`- ${extra}`);
  }

  if (testOutput) {
    lines.push("");
    lines.push("验证:");
    lines.push(truncate(testOutput, 500) || "(空)");
  }

  return lines.join("\n");
}

function bugUrl(ws: string, id: string): string {
  return `https://www.tapd.cn/${ws}/bugtrace/bugs/view?bug_id=${id}`;
}
