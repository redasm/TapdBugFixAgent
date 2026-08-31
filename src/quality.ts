/** 自动修复输入质量：把 TAPD 字段整理成稳定上下文，并在修改代码前做准入判断。 */

import type { Bug } from "./models.js";

export interface BugContext {
  title: string;
  module: string;
  description: string;
  reproduction_steps: string;
  expected_result: string;
  actual_result: string;
  environment: string[];
  logs: string[];
  diagnostic_links: string[];
  comments: string[];
  attachments: string[];
}

export interface AdmissionPolicy {
  min_score: number;
  require_reproduction_signal: boolean;
  manual_keywords: string[];
  high_risk_keywords: string[];
}

export type AdmissionDisposition = "auto_fix" | "needs_info" | "manual_only" | "manual_review";

export interface FixabilityAssessment {
  eligible: boolean;
  disposition: AdmissionDisposition;
  score: number;
  reasons: string[];
  context: BugContext;
}

const textValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
};

const firstText = (raw: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = textValue(raw[key]);
    if (value) return value;
  }
  return "";
};

const descriptionSection = (description: string, labels: string[]): string => {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const nextLabels = "复现步骤|重现步骤|操作步骤|预期结果|期望结果|实际结果|当前结果|环境|版本|日志";
  const match = description.match(new RegExp(`(?:${escaped})[：:]\\s*([\\s\\S]*?)(?=(?:${nextLabels})[：:]|$)`, "i"));
  return match?.[1]?.trim() ?? "";
};

const collectStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean);
  }
  const one = textValue(value);
  return one ? [one] : [];
};

const collectAttachments = (value: unknown): string[] => {
  if (!Array.isArray(value)) return collectStrings(value);
  const attachments: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      attachments.push(...collectStrings(item));
      continue;
    }
    const data = item as Record<string, unknown>;
    const name = firstText(data, ["name", "filename", "file_name", "attachment_name", "title"]);
    const url = firstText(data, ["download_url", "url", "path"]);
    if (name || url) attachments.push(name && url ? `${name}: ${url}` : name || url);
  }
  return attachments;
};

const collectComments = (value: unknown): string[] => {
  if (!Array.isArray(value)) return collectStrings(value);
  const comments: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      comments.push(...collectStrings(item));
      continue;
    }
    const data = item as Record<string, unknown>;
    const body = firstText(data, ["description", "content", "comment", "text"]);
    const author = firstText(data, ["author", "creator", "user", "name"]);
    if (body) comments.push(author ? `${author}: ${body}` : body);
  }
  return comments;
};

const diagnosticLinks = (...values: string[]): string[] => {
  const links: string[] = [];
  for (const value of values) {
    for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const url = match[0].replace(/[),.;，。；]+$/g, "");
      if (/crashsight|sentry|crash-report|issue|exception|error/i.test(url)) links.push(url);
    }
  }
  return [...new Set(links)];
};

const crashDiagnostic = (text: string): boolean =>
  /(?:crashsight|sentry|fatal\s+error|crash|崩溃|异常进程|异常线程|出错堆栈|stack\s*trace|checkverify|assert(?:ion)?|ensure\s*failed|exception|\.cpp:\d+|\.h:\d+)/i.test(text);

const inferModule = (title: string, description: string): string => {
  const text = `${title}\n${description}`;
  const pathPatterns = [
    /Engine[\\/]Plugins[\\/]Kuro[\\/]([^\\/\s]+)/i,
    /Engine[\\/]Source[\\/]Runtime[\\/]([^\\/\s]+)/i,
    /TypeScript[\\/]Src[\\/]Game[\\/]Module[\\/]([^\\/\s]+)/i,
  ];
  for (const pattern of pathPatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  const labels = [...title.matchAll(/【([^】]+)】/g)].map((match) => match[1].trim());
  return labels.find((label) => !/^(?:CrashSight一键提单|Crash|崩溃)$/i.test(label)) ?? "";
};

export const buildBugContext = (bug: Bug): BugContext => {
  const raw = bug.raw ?? {};
  const description = bug.description.trim();
  const comments = collectComments(raw.comments ?? raw.comment_list);
  const attachments = collectAttachments(raw.attachments ?? raw.attachment_list);
  const logs = collectStrings(raw.logs ?? raw.log ?? raw.stack_trace ?? raw.stack);
  const reproduction = firstText(raw, ["steps", "reproduction_steps", "reproduce_steps", "repro_steps"])
    || descriptionSection(description, ["复现步骤", "重现步骤", "操作步骤"]);
  const expected = firstText(raw, ["expectation", "expected", "expected_result"])
    || descriptionSection(description, ["预期结果", "期望结果"]);
  const actual = firstText(raw, ["actual", "actual_result", "current_result"])
    || descriptionSection(description, ["实际结果", "当前结果"]);

  const environment: string[] = [];
  const envFields: Array<[string, string[]]> = [
    ["版本", ["version_report", "version", "build", "found_version"]],
    ["平台", ["platform", "device_platform"]],
    ["系统", ["os", "operating_system"]],
    ["分支", ["branch", "branch_name"]],
  ];
  for (const [label, keys] of envFields) {
    const value = firstText(raw, keys);
    if (value) environment.push(`${label}: ${value}`);
  }

  return {
    title: bug.title.trim(),
    module: bug.module.trim() || inferModule(bug.title, description),
    description,
    reproduction_steps: reproduction,
    expected_result: expected,
    actual_result: actual,
    environment,
    logs,
    diagnostic_links: diagnosticLinks(description, ...logs, ...comments, ...attachments),
    comments,
    attachments,
  };
};

const display = (value: string): string => value || "（缺失）";

export const formatBugContext = (context: BugContext): string => [
  `标题: ${display(context.title)}`,
  `模块: ${display(context.module)}`,
  `问题描述: ${display(context.description)}`,
  `复现步骤: ${display(context.reproduction_steps)}`,
  `预期结果: ${display(context.expected_result)}`,
  `实际结果: ${display(context.actual_result)}`,
  `环境与版本:\n${context.environment.length ? context.environment.map((v) => `- ${v}`).join("\n") : "- （缺失）"}`,
  `日志与堆栈:\n${context.logs.length ? context.logs.map((v) => `- ${v}`).join("\n") : "- （缺失）"}`,
  `外部诊断链接:\n${context.diagnostic_links.length ? context.diagnostic_links.map((v) => `- ${v}`).join("\n") : "- （缺失）"}`,
  `历史评论:\n${context.comments.length ? context.comments.map((v) => `- ${v}`).join("\n") : "- （缺失）"}`,
  `附件:\n${context.attachments.length ? context.attachments.map((v) => `- ${v}`).join("\n") : "- （缺失）"}`,
].join("\n");

const containsKeyword = (haystack: string, keywords: string[]): string | undefined => {
  const lower = haystack.toLowerCase();
  return keywords.find((keyword) => keyword.trim() && lower.includes(keyword.toLowerCase()));
};

const matchingKeywords = (haystack: string, keywords: string[]): string[] => {
  const lower = haystack.toLowerCase();
  return [...new Set(keywords.filter((keyword) =>
    keyword.trim() && lower.includes(keyword.toLowerCase()),
  ))];
};

/** 高风险判断只看“问题本身”，不扫描复现步骤里的测试账号、登录前置等操作条件。 */
const highRiskEvidenceText = (context: BugContext): string => {
  const structuralLabel = /(?:前置条件|测试账号|测试帐号|账号|帐号|测试角色|服务器|区服|复现步骤|重现步骤|操作步骤|环境|版本|日志)[：:]/i;
  const summary = context.description.split(structuralLabel, 1)[0].trim();
  return [
    context.title,
    context.module,
    context.expected_result,
    context.actual_result,
    summary,
  ].filter(Boolean).join("\n");
};

export const assessFixability = (
  bug: Bug,
  policy: AdmissionPolicy,
  automatableManualKeywords: string[] = [],
): FixabilityAssessment => {
  const context = buildBugContext(bug);
  const evidenceText = [context.title, context.module, context.description, context.reproduction_steps].join("\n");
  const hasCrashEvidence = crashDiagnostic([
    context.title,
    context.description,
    ...context.logs,
    ...context.comments,
    ...context.diagnostic_links,
  ].join("\n"));
  const hasDiagnosticEvidence = hasCrashEvidence || context.diagnostic_links.length > 0;
  const manualKeywords = matchingKeywords(evidenceText, policy.manual_keywords);
  const automatable = new Set(automatableManualKeywords.map((keyword) => keyword.trim().toLowerCase()));
  const uncoveredManualKeywords = manualKeywords.filter((keyword) => !automatable.has(keyword.toLowerCase()));
  if (uncoveredManualKeywords.length) {
    return {
      eligible: false,
      disposition: "manual_only",
      score: 0,
      reasons: [`涉及需人工处理的资源或工具: ${uncoveredManualKeywords.join(", ")}`],
      context,
    };
  }

  const riskKeyword = containsKeyword(highRiskEvidenceText(context), policy.high_risk_keywords);
  if (riskKeyword) {
    return {
      eligible: false,
      disposition: "manual_review",
      score: 0,
      reasons: [`涉及高风险领域，必须人工确认: ${riskKeyword}`],
      context,
    };
  }

  let score = 0;
  const reasons: string[] = [];
  // 很多 TAPD 单把“操作 + 异常 + 预期”完整写在标题里，描述字段反而为空。
  // 这类标题足以进入只读调查；调查阶段仍会在证据不足时 fail closed。
  const actionableTitle = context.title.length >= 16
    && /(异常|错误|报错|失败|未|没有|缺少|残留|消失|卡住|重复|误触发|不(?:能|会|显示|生效|正确)|预期|crash|fatal|exception|assert|ensure|checkverify|崩溃)/i.test(context.title);
  if (context.title.length >= 6) score += 10;
  else reasons.push("标题过于笼统");
  if (context.module) score += 10;
  else reasons.push("缺少模块信息");
  if (context.description.length >= 20) score += 10;
  else reasons.push("问题描述过短");
  if (context.reproduction_steps) score += 30;
  else if (hasDiagnosticEvidence) score += 30;
  else if (actionableTitle) score += 20;
  else reasons.push("缺少复现步骤或可复现信号");
  if (context.expected_result) score += 15;
  else if (hasCrashEvidence) score += 15;
  else if (actionableTitle) score += 10;
  else reasons.push("缺少预期结果");
  if (context.actual_result) score += 15;
  else if (hasCrashEvidence) score += 15;
  else if (actionableTitle) score += 10;
  else reasons.push("缺少实际结果");
  if (context.logs.length || context.comments.length || context.diagnostic_links.length || hasCrashEvidence) score += 10;

  const reproductionMissing = policy.require_reproduction_signal
    && !context.reproduction_steps
    && !context.logs.length
    && !hasDiagnosticEvidence
    && !actionableTitle;
  const eligible = score >= policy.min_score && !reproductionMissing;
  return {
    eligible,
    disposition: eligible ? "auto_fix" : "needs_info",
    score,
    reasons: eligible ? [] : reasons,
    context,
  };
};
