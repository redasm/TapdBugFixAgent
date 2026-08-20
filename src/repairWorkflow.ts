/** Codex 风格的 Bug 修复协议：只读调查确定根因，再由写入阶段实施最小补丁。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFinalJson } from "./agent.js";
import type { Bug } from "./models.js";
import { buildBugContext, formatBugContext } from "./quality.js";

export interface ReproductionEvidence {
  command: string;
  before: string;
}

export interface InvestigationResult {
  ok: boolean;
  root_cause: string;
  evidence: string[];
  reproduction: ReproductionEvidence;
  planned_files: string[];
  confidence: number;
  blocked_reasons: string[];
  validation_errors: string[];
}

export interface ImplementationPromptInput {
  bug: Bug;
  repoName: string;
  repoPath: string;
  verifyCommands: string[];
  investigation: InvestigationResult;
  retryEvidence: string;
  reviewerFeedback: string;
}

const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.map((v) => String(v ?? "").trim()).filter(Boolean)
  : [];

const PLAYBOOK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "defensive-patterns.md",
);

const loadRepairPlaybook = (): string => {
  try {
    return fs.readFileSync(PLAYBOOK_PATH, "utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/^---[\s\S]*?---\s*/, "")
      .replace(/^#[^\n]*\n/, "")
      .trim()
      .slice(0, 4000);
  } catch {
    return "";
  }
};

export const buildInvestigationPrompt = (bug: Bug, repoName: string, repoPath: string): string => {
  const context = formatBugContext(buildBugContext(bug));
  return `你是 Bug 调查 Agent。当前是只读调查阶段，禁止修改、创建或删除任何文件，也禁止执行 p4 edit/add/delete。

# 目标
在修改代码前确定最可能的根因、可核查的代码证据、复现方法和最小修改范围。缺少证据时必须停止，不得猜测修复。

# Bug 上下文
${context}

# 仓库
名称: ${repoName}
路径: ${repoPath}

# 调查要求
1. 阅读仓库说明、团队规则和相关模块代码，沿调用链定位状态写入与读取位置。
2. 优先使用现有测试、日志或最小只读命令复现；不要为了“证明”结论而修改代码。
3. evidence 必须包含可定位的文件、符号或行附近事实，不能只有泛化推测。
4. planned_files 只列预计需要修改的最小文件集合。
5. 无法形成可靠根因时，把缺失信息写入 blocked_reasons，confidence 不得高于 0.5。

# 输出
最后严格输出：
FINAL_RESULT:
\`\`\`json
{"root_cause":"根因","evidence":["文件/符号/事实"],"reproduction":{"command":"复现或相关测试命令；没有则为空","before":"修复前观察到的失败"},"planned_files":["相对仓库路径"],"confidence":0.0,"blocked_reasons":[]}
\`\`\``;
};

export const parseInvestigation = (output: string): InvestigationResult => {
  const data = extractFinalJson(output) ?? {};
  const rootCause = String(data.root_cause ?? "").trim();
  const evidence = strings(data.evidence);
  const plannedFiles = strings(data.planned_files);
  const reproductionData = data.reproduction && typeof data.reproduction === "object"
    ? data.reproduction as Record<string, unknown>
    : {};
  const reproduction = {
    command: String(reproductionData.command ?? "").trim(),
    before: String(reproductionData.before ?? "").trim(),
  };
  const confidenceRaw = Number(data.confidence ?? 0);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
  const blockedReasons = strings(data.blocked_reasons);
  const validationErrors: string[] = [];
  if (!rootCause) validationErrors.push("调查结果缺少 root_cause");
  if (!evidence.length) validationErrors.push("调查结果缺少可核查 evidence");
  if (!plannedFiles.length && !blockedReasons.length) validationErrors.push("调查结果缺少 planned_files");
  if (confidence < 0.6 && !blockedReasons.length) validationErrors.push("调查置信度不足且未说明阻塞原因");

  return {
    ok: validationErrors.length === 0 && blockedReasons.length === 0,
    root_cause: rootCause,
    evidence,
    reproduction,
    planned_files: plannedFiles,
    confidence,
    blocked_reasons: blockedReasons,
    validation_errors: validationErrors,
  };
};

export const buildImplementationPrompt = (input: ImplementationPromptInput): string => {
  const { bug, investigation } = input;
  const context = formatBugContext(buildBugContext(bug));
  const verification = input.verifyCommands.length
    ? input.verifyCommands.map((command) => `- ${command}`).join("\n")
    : "- （未配置机器验证命令；完成后将只能生成候选补丁，不能标记为已验证）";
  const retry = input.retryEvidence.trim()
    ? `\n# 上次失败证据\n${input.retryEvidence.trim()}\n`
    : "";
  const review = input.reviewerFeedback.trim()
    ? `\n# Reviewer 必须修复的问题\n${input.reviewerFeedback.trim()}\n`
    : "";
  const playbook = loadRepairPlaybook();
  const playbookSection = playbook
    ? `\n# 修复守则（涉及异步、事件、生命周期或清理代码时必须对照）\n${playbook}\n`
    : "";

  return `你是 Bug 修复 Agent。调查阶段已经完成；请依据已确认的证据实施最小补丁，不得重新猜测一个无证据的方向。

# Bug 上下文
${context}

# 已确认的调查结论
根因: ${investigation.root_cause}
置信度: ${investigation.confidence}
证据:
${investigation.evidence.map((item) => `- ${item}`).join("\n")}
修复前复现命令: ${investigation.reproduction.command || "（调查阶段未找到）"}
修复前失败现象: ${investigation.reproduction.before || "（调查阶段未记录）"}
计划修改文件:
${investigation.planned_files.map((file) => `- ${file}`).join("\n")}
${retry}${review}${playbookSection}
# 工作区规则（Perforce）
1. 修改已有文件前执行 p4 edit；新建文件后执行 p4 add。
2. 禁止 p4 submit / p4 revert / p4 sync / p4 change，只使用 default changelist。
3. 只修改计划范围；发现必须扩大范围时停止并写入 blocked_reasons。
4. 涉及 prefab、场景、图集、表格或二进制资源时不要强改，列入 manual_assets。

# 实施要求
1. 先运行或补充能复现该 Bug 的回归测试，确认修复前失败；如果客观上无法自动复现，在 summary 中明确证据和限制。
2. 只实现解决已确认根因所需的最小修改，不做邻近重构、格式化或额外功能。
3. 修改后重跑同一复现，并按顺序运行机器验证命令：
${verification}
4. 输出中必须如实记录实际运行过的命令和结果，不得把“未运行”写成“通过”。

# 仓库
名称: ${input.repoName}
路径: ${input.repoPath}

# 输出
最后严格输出：
FINAL_RESULT:
\`\`\`json
{"summary":"根因、最小改动、修复前后验证结果","changed_files":["相对仓库路径"],"manual_assets":[],"blocked_reasons":[]}
\`\`\``;
};
