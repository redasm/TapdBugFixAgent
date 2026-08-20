/** 独立只读评审协议：基于目标、调查证据、机器验证和完整 diff 输出可执行 findings。 */

import { extractFinalJson } from "./agent.js";
import type { Bug } from "./models.js";
import type { InvestigationResult } from "./repairWorkflow.js";
import { buildBugContext, formatBugContext } from "./quality.js";

export type FindingSeverity = "low" | "medium" | "high";

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  file: string;
  line: number | null;
  evidence: string;
  required_action: string;
}

export interface ReviewResult {
  approved: boolean;
  note: string;
  findings: ReviewFinding[];
}

export interface ReviewPromptInput {
  bug: Bug;
  investigation: InvestigationResult;
  diff: string;
  verificationSummary: string;
}

export const buildReviewPrompt = (input: ReviewPromptInput): string => `你是独立的只读代码评审 Agent。不得修改工作区、不得执行 p4 edit/add/delete，只审查给定改动。

# 评审目标
判断补丁是否解决已确认根因、是否保持最小范围、是否有明显回归或遗漏错误路径，以及机器验证是否足以支撑结论。只报告补丁引入或未解决的具体问题。

# Bug 上下文
${formatBugContext(buildBugContext(input.bug))}

# 调查结论
根因: ${input.investigation.root_cause}
证据:
${input.investigation.evidence.map((item) => `- ${item}`).join("\n")}
计划文件:
${input.investigation.planned_files.map((item) => `- ${item}`).join("\n")}

# 机器验证
${input.verificationSummary || "（没有机器验证证据）"}

# 完整 diff
${input.diff}

# 判定规则
- high: 会导致修复无效、数据损坏、严重回归或安全问题。
- medium: 明确的功能遗漏、边界问题或测试缺口，提交前应修复。
- low: 不阻止提交的局部改进建议。
- 只要存在 high 或 medium finding，approved 必须为 false。
- 每条 finding 必须有证据和可执行 required_action；不要写泛泛建议。

最后严格输出：
FINAL_RESULT:
\`\`\`json
{"approved":true,"note":"结论","findings":[{"severity":"high|medium|low","title":"短标题","file":"相对路径","line":42,"evidence":"具体证据","required_action":"必须采取的修正"}]}
\`\`\``;

const severity = (value: unknown): FindingSeverity => {
  const text = String(value ?? "").toLowerCase();
  if (text === "high" || text === "medium") return text;
  return "low";
};

const findingFrom = (value: unknown): ReviewFinding | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const title = String(data.title ?? "").trim();
  const action = String(data.required_action ?? "").trim();
  const evidence = String(data.evidence ?? "").trim();
  if (!title || !action || !evidence) return undefined;
  const lineRaw = Number(data.line);
  return {
    severity: severity(data.severity),
    title,
    file: String(data.file ?? "").trim(),
    line: Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : null,
    evidence,
    required_action: action,
  };
};

export const parseReviewResult = (output: string): ReviewResult => {
  const data = extractFinalJson(output);
  if (!data) {
    return {
      approved: false,
      note: "Reviewer 输出无法解析，按保守策略拒绝",
      findings: [{
        severity: "high",
        title: "无法解析 Reviewer 输出",
        file: "",
        line: null,
        evidence: output.slice(-500) || "无输出",
        required_action: "重新执行独立代码评审",
      }],
    };
  }
  const findings = Array.isArray(data.findings)
    ? data.findings.map(findingFrom).filter((item): item is ReviewFinding => !!item)
    : [];
  const blocking = findings.some((finding) => finding.severity !== "low");
  return {
    approved: data.approved === true && !blocking,
    note: String(data.note ?? "").trim(),
    findings,
  };
};

export const formatReviewerFeedback = (result: ReviewResult): string => {
  if (!result.findings.length) return result.note;
  return result.findings.map((finding, index) => {
    const location = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "未指定位置";
    return `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title} (${location})\n`
      + `   证据: ${finding.evidence}\n   必须修正: ${finding.required_action}`;
  }).join("\n");
};
