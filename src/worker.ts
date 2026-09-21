/** 编排工作线程：调查、修复、验证、评审、pending changelist 与 Tapd 回写。 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defaultSearchPaths } from "./search.js";
import { formatVerificationCommand } from "./verificationCommands.js";
import { evidenceHash, hasPatchEvidence } from "./attemptAudit.js";
import { sourceEvidence, runtimeEvidence } from "./sourceEvidence.js";
import { scopeAmendment, validateAmendedScope, reviewScopeAmendment, reviewScopeAmendmentForWritten } from "./scopeAmendment.js";
import { buildBugContext } from "./quality.js";
import { feedbackMemories, selectFeedbackMemories, formatFeedbackMemories } from "./feedbackMemory.js";
import { prepareBehaviorChecks, verifyBehaviorChecks, type FrozenBehaviorCheck, type BehaviorVerification } from "./behaviorChecks.js";
import { captureInvestigationProgress, compactInvestigationTrace, type InvestigationProgress } from "./investigationProgress.js";

import type { AdditionalDirConfig, Config, RepoConfig, WorkspaceConfig } from "./config.js";
import { priorityRank } from "./config.js";
import type { AgentResult, Bug, RetryEvidenceEntry } from "./models.js";
import { bugUrl, dumps, hasCodeChanges, hasManualAssets, loads, truncate } from "./models.js";
import type { OpenedFile } from "./p4.js";
import {
  ensureP4IgnoreFile,
  P4CancelledError,
  P4Client,
  P4ConnectionError,
  P4Error,
  P4SyncTimeoutError,
} from "./p4.js";
import { buildDescription } from "./descgen.js";
import {
  assessPatchScope,
  assessPlannedScope,
  checkAndPrepareP4,
  p4ReconcileTargets,
  runVerificationPipeline,
  VerificationError,
} from "./verify.js";
import {
  AgentCancelledError,
  AgentInfrastructureError,
  AgentInvestigationLimitError,
  AgentTimeoutError,
  CancelEvent,
  PiAgent,
  ProviderUnavailableError,
  effectivePiModel,
  formatRetryEvidence,
  resultFromOutput,
  withRecoveryEvidence,
} from "./agent.js";
import { nowStr, type StateStore } from "./state.js";
import { assessFixabilityWithNarrative } from "./admission.js";
import {
  automatableManualKeywords,
  configuredManualKeywords,
  enabledMcpServerNames,
  mcpServerNamesMatchingText,
} from "./mcpServers.js";
import {
  BASELINE_UNCONFIRMED_PREFIX,
  BUSINESS_QUESTION_PREFIX,
  buildImplementationPrompt,
  buildInvestigationPrompt,
  buildInvestigationContinuationPrompt,
  buildInvestigationRecoveryPrompt,
  buildInvestigationTimeoutRecoveryPrompt,
  parseInvestigation,
  type InvestigationResult,
} from "./repairWorkflow.js";
import {
  buildReviewPrompt,
  formatReviewerFeedback,
  parseReviewResult,
  reviewerModel,
  type ReviewResult,
} from "./review.js";
import { isVerificationLimitation } from "./repairContract.js";
import { createTapdClient, type TapdBackend, TapdError } from "./tapd.js";
import type { AgentMediaInput } from "./media.js";
import {
  agentRoleEnabled,
  agentRoleModel,
  agentRoleSnapshot,
  agentRoleTimeoutS,
  type AgentRole,
} from "./agentRoles.js";
import {
  buildCoordinatorPlanPrompt,
  buildCoordinatorSummaryPrompt,
  formatCoordinatorPlanForPrompt,
  formatCoordinatorSummaryForDelivery,
  parseCoordinatorPlan,
  parseCoordinatorSummary,
  type CoordinatorSummary,
} from "./coordinator.js";
import {
  GitWorkspace,
  GitWorkspaceError,
  type GitBranchSession,
  type GitFinalizeResult,
} from "./git.js";

// 终态：已处理（不会自动重新处理）
const _TERMINAL_STATES = new Set([
  "candidate", "candidate_partial", "verified", "review_pending",
  "accepted", "accepted_modified", "rejected", "reopened",
  "needs_info", "manual_review", "blocked_workspace",
  "manual_only", "failed", "skipped",
]);
const _RESYNC_PRESERVED_STATES = [
  "candidate", "candidate_partial", "verified", "review_pending", "manual_review", "manual_only",
  "accepted", "accepted_modified", "rejected", "reopened",
];
const _FETCH_CACHE_MS = 60000;
const _MAX_EVIDENCE_ENTRIES = 6; // 重试证据最多保留最近 6 次失败
// 大型仓库的一次并行搜索、分段读取或 MCP 属性检查都可能产生多条工具事件。
// 不按调用次数强杀，避免把正常调查误判成循环；总超时与重复命令守卫负责止损。
const _INVESTIGATION_COMMAND_BUDGET = Number.POSITIVE_INFINITY;
const _IMPLEMENTATION_COMMAND_BUDGET = Number.POSITIVE_INFINITY;
const _REVIEW_COMMAND_BUDGET = Number.POSITIVE_INFINITY;
/** 无工具收尾轮一次工具都不会调用，预算沿用「不限次数」；真正的约束是派生超时。 */
const _RECOVERY_COMMAND_BUDGET = Number.POSITIVE_INFINITY;
/** 补充核查轮只补查缺失项：给有限工具预算（覆盖已观测到的绝大多数补充轮），
 *  避免在时限内无限刷工具而不收束。主调查仍不设工具总量上限。 */
export const SUPPLEMENTARY_COMMAND_BUDGET = 40;
/** 无工具收尾轮的整轮上限：主调查 1 次 + 补充核查 1 次。 */
const _TOOLS_FREE_RECOVERY_LIMIT = 2;
const _REPEATED_COMMAND_LIMIT = 3;
const _IMPLEMENTATION_READ_ONLY_BEFORE_WRITE_LIMIT = Number.POSITIVE_INFINITY;
const _IMPLEMENTATION_RECOVERY_TIMEOUT_S = 180;

// ---------------------------------------------------------------------------
// provider 全局冷却
// ---------------------------------------------------------------------------
/** transient（限流/网络/5xx）退避基数与上限：有界指数退避，不会无限增长。 */
export const _PROVIDER_BACKOFF_BASE_MS = 30_000;
export const _PROVIDER_BACKOFF_MAX_MS = 10 * 60_000;
/** quota/auth 冷却基数与上限：短期重试无意义，给长冷却并提示人工处理。 */
export const _PROVIDER_QUOTA_BASE_MS = 15 * 60_000;
export const _PROVIDER_QUOTA_MAX_MS = 2 * 60 * 60_000;
/** 冷却期间工作循环的单次休眠上限：非忙轮询，同时保证能在上限内感知人工提前解除。 */
export const _PROVIDER_COOLDOWN_SLEEP_MAX_MS = 60_000;

/** 由故障类型 + 连续失败次数计算全局冷却时长（有界）。
 *  transient 从 30s 起、每失败一次翻倍，10 分钟封顶；quota/auth 从 15 分钟起，2 小时封顶。
 *  上限保证「不永久静默停机」：到期后一定会再探测一次。 */
export function providerCooldownMs(kind: string, failures: number): number {
  const longCooldown = kind === "quota" || kind === "auth";
  const base = longCooldown ? _PROVIDER_QUOTA_BASE_MS : _PROVIDER_BACKOFF_BASE_MS;
  const cap = longCooldown ? _PROVIDER_QUOTA_MAX_MS : _PROVIDER_BACKOFF_MAX_MS;
  const step = Math.max(1, Math.min(16, Math.floor(failures) || 1));
  return Math.min(cap, base * 2 ** (step - 1));
}

/** 历史误阻塞恢复判定（刻意从严）。
 *  仅当失败原因是「显式的 provider 错误标记」且不含任何 Git/P4/工作区 cleanup 证据时，
 *  才认为它是被旧版本误标成工作区阻塞的 provider 故障。
 *  方向性取舍：漏恢复只是继续需要人工点重试；误恢复会把真实工作区阻塞放进自动队列，
 *  可能把遗留改动混进下一个补丁——因此宁可漏，不可误。
 *  刻意不匹配泛化的 `stopReason=error`：该文本无法区分 provider 与其它异常。 */
export function isRecoverableProviderBlock(failureReason: unknown): boolean {
  const reason = String(failureReason ?? "");
  if (!/Pi provider error:/i.test(reason)) return false;
  return !/(Git|P4|changelist|工作区|workspace|reconcile|revert|\bsync\b|未提交|未登记|清理)/i.test(reason);
}

// ---------------------------------------------------------------------------
// 当前阶段（管理台展示用）
// ---------------------------------------------------------------------------
/** 处理流程中可被管理台展示的阶段。取值与 processBug 内部的 phase 变量逐字一致
 *  （审计里 historical 的 "correction" 仍是该阶段调用时写入的审计 phase 名）。 */
export type WorkerStage = "preflight" | "admission" | "investigation" | "implementation"
  | "verification" | "review" | "correction";

/** 阶段 → 中文说明。写死的是「编排流程阶段」的措辞（不是模型能力描述），
 *  改文案只影响管理台「处理中 N」分组标题栏的阶段显示，不影响审计与其它日志。 */
const _STAGE_LABEL: Record<WorkerStage, string> = {
  preflight: "准备环境（P4 / Git 工作区检查）",
  admission: "准入评估",
  investigation: "只读调查",
  implementation: "实施编码",
  verification: "机器验证",
  review: "独立评审",
  correction: "评审后定向修正",
};

/** 该阶段实际调用 Agent 时生效的角色：模型必须与「调用时真正传给 pi 的模型」同一来源，
 *  因此统一走 agentRoleModel(role) || effectivePiModel()（与 PiAgent.run 的解析顺序一致）。
 *  验证阶段由编排器自己跑构建/测试，不调用模型，返回 null 由调用方回落。 */
const stageAgentRole = (stage: WorkerStage): AgentRole | null => stage === "correction"
  ? "recovery"
  : stage === "investigation" || stage === "implementation" || stage === "review"
    ? stage
    : null;

/** 阶段时限的规范化：NaN / 非正值 / Infinity 一律抛错。
 *  配置错误必须显式暴露，不能悄悄退化成「无时限」。 */
const phaseTotalSeconds = (agentTimeoutS: number): number => {
  const total = Math.floor(Number(agentTimeoutS));
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`agent_timeout_s 必须是正数（秒），当前值无法用于计算阶段时限: ${String(agentTimeoutS)}`);
  }
  return total;
};

/** 主调查时限：直接使用 agent_timeout_s（不再硬钳到 600s）。
 *  agent_timeout_s 是「每次调用/每个阶段」的预算，不是整单总时限；多轮调用会累加。 */
export const mainInvestigationTimeoutS = (agentTimeoutS: number): number =>
  phaseTotalSeconds(agentTimeoutS);

/** 派生调用（无工具收尾、补充核查）时限：按总配置派生且始终有限。
 *  min(agent_timeout_s, max(180, agent_timeout_s / 3))——默认 1800 → 600；
 *  总时限较小时尊重总时限（如 120 → 120），不会被抬到 180 以上。 */
export const derivedRecoveryTimeoutS = (agentTimeoutS: number): number => {
  const total = phaseTotalSeconds(agentTimeoutS);
  return Math.min(total, Math.max(180, Math.round(total / 3)));
};
const _IMPLEMENTATION_RECOVERY_COMMAND_BUDGET = Number.POSITIVE_INFINITY;
const _IMPLEMENTATION_RECOVERY_READ_ONLY_BEFORE_WRITE_LIMIT = Number.POSITIVE_INFINITY;

/** coordinator（只读、无工具、只产出文字建议）两处调用的派生时限上限。
 *  它不参与任何决策，因此预算刻意很小：宁可降级成「本次没有建议」，也不占用正式阶段的预算。
 *  实际时限 = min(agents.roles.coordinator.timeout_s 配置值, 这里的上限)，只会收紧不会放大。 */
export const _COORDINATOR_PLAN_TIMEOUT_S = 120;
export const _COORDINATOR_SUMMARY_TIMEOUT_S = 90;

const buildImplementationRecoveryPrompt = (
  originalPrompt: string,
  partialOutput: string,
): string => `${originalPrompt}

# 编码阶段已进入强制收尾
上一轮在规定时间内没有产生真实文件写入，已停止无效停滞。下面仅保留其已有轨迹供参考：
<partial_implementation>
${partialOutput.trim().slice(-32000) || "（没有保留下可用轨迹）"}
</partial_implementation>

禁止重新调查整个仓库、重新读取附件或扩大搜索范围。只允许对调查阶段的 planned_files 做少量必要确认，然后立即实施最小修复并运行最小相关验证。
如果现有调查结论不足以安全修改，请立即在 blocked_reasons 中说明具体缺失证据；不要继续消耗时间等待外层超时。最后必须输出完整 FINAL_RESULT。`;

const withPreopenedP4Files = (prompt: string): string => prompt
  .replace(
    `1. project（Perforce）中修改已有文件前执行 p4 edit；新建文件后执行 p4 add。
2. 禁止 p4 submit / p4 revert / p4 sync / p4 change，只使用 default changelist。`,
    `1. 编排器已在 default changelist 中打开所有实际存在的 project（Perforce）计划文件；Agent 沙箱无法连接 Perforce，禁止执行任何 p4 命令（包括 p4 edit/sync/change/opened/diff/status/filelog/annotate/add）。只需直接编辑已有文件；确需新建 planned_files 中明确列出的文件时直接创建，编排器会在 Agent 完成后统一执行 p4 add。
2. Perforce 状态、diff、reconcile、changelist 创建与清理均由编排器在 Agent 返回后执行；不得因 Agent 侧无法连接 P4 而写入 blocked_reasons。`,
  )
  .replace(
    "6. 禁止在 Perforce 根执行 git status/log/blame/diff；Perforce 历史与差异只使用 p4 filelog、p4 annotate、p4 diff。",
    "6. 禁止在 Perforce 根执行 git status/log/blame/diff，也禁止在 Agent 内执行 p4 历史、状态或差异命令；所需完整 diff 由编排器在 Agent 返回后生成。",
  )
  .replace(
    "- `p4 edit` 只是在 Perforce 中打开文件，不算已经落笔；必须随后使用编辑工具或补丁实际修改内容。宿主会在实施阶段长期只有只读调用而没有真实写入时提前终止。",
    "- project 计划文件已由编排器预打开；必须使用编辑工具或补丁实际修改内容。宿主会在实施阶段长期只有只读调用而没有真实写入时提前终止。",
  );

/** 工作区中存在无法安全归属当前 Bug 的改动；这是操作阻塞，不应消耗模型修复次数。 */
class WorkspaceBlockedError extends Error {}

/** 调查在有限预算内无法收敛；保留证据并等待人工补充，不重复跑相同搜索。 */
class InvestigationBlockedError extends Error {}

const isConcretePlannedFile = (value: string): boolean => {
  const normalized = value.replace(/\\/g, "/").trim();
  const separator = normalized.indexOf(":");
  const relative = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const name = relative.split("/").pop() ?? "";
  return /\.[a-z0-9][a-z0-9._-]*$/i.test(name)
    && !/[（）()]/.test(relative)
    && !/^(?:src|source|content|typescript)$/i.test(name);
};

const requireConcretePlannedFiles = (investigation: InvestigationResult): InvestigationResult => {
  if (!investigation.ok) return investigation;
  const invalid = investigation.planned_files.filter((file) => !isConcretePlannedFile(file));
  if (!invalid.length) return investigation;
  return {
    ...investigation,
    ok: false,
    validation_errors: [
      ...investigation.validation_errors,
      `planned_files 必须是已定位且带扩展名的具体文件，不能是目录、候选范围或说明文字: ${invalid.join(", ")}`,
    ],
  };
};

const plannedFilePath = (
  value: string,
  roots: Array<{ alias: string; path: string }>,
): string | null => {
  const normalized = value.replace(/\\/g, "/").trim();
  const separator = normalized.indexOf(":");
  const alias = (separator >= 0 ? normalized.slice(0, separator) : "project").toLowerCase();
  const relative = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const root = roots.find((item) => item.alias.toLowerCase() === alias);
  if (!root || !relative || !fs.existsSync(root.path)) return null;
  return path.resolve(root.path, ...relative.split("/"));
};

const explicitlyPlannedAsNew = (investigation: InvestigationResult, file: string): boolean => {
  const normalized = file.replace(/\\/g, "/");
  const relative = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1) : normalized;
  return investigation.evidence.some((item) =>
    /\[(?:新文件|新增)\]|(?:新建|新增)(?:测试)?文件/.test(item) && item.replace(/\\/g, "/").includes(relative));
};

export const requireExistingPlannedFiles = (
  investigation: InvestigationResult,
  roots: Array<{ alias: string; path: string }>,
): InvestigationResult => {
  if (!investigation.ok) return investigation;
  const unknownRoots = investigation.planned_files.filter((file) => {
    const separator = file.indexOf(":");
    const alias = separator >= 0 ? file.slice(0, separator).toLowerCase() : "project";
    return !roots.some((root) => root.alias.toLowerCase() === alias);
  });
  if (unknownRoots.length) return {
    ...investigation,
    ok: false,
    validation_errors: [...investigation.validation_errors,
      `planned_files 使用了未配置的根别名，只能使用 ${roots.map((root) => root.alias).join(", ")}: ${unknownRoots.join(", ")}`],
  };
  const missing = investigation.planned_files.filter((file) => {
    const resolved = plannedFilePath(file, roots);
    return resolved !== null && !fs.existsSync(resolved) && !explicitlyPlannedAsNew(investigation, file);
  });
  if (!missing.length) return investigation;
  return {
    ...investigation,
    ok: false,
    validation_errors: [
      ...investigation.validation_errors,
      `planned_files 在对应工作区中不存在，请重新搜索并改为实际文件路径；如确需新建，须在 evidence 中用 [新文件] 明确说明: ${missing.join(", ")}`,
    ],
  };
};

/** 严格校验链：结构化解析 → planned_files 必须是具体文件 → 文件必须已存在（[新文件] 例外）。
 *  主结果、超时部分结果、无工具收尾结果、补充核查结果都走同一条链，不能只看 parse.ok。 */
export const validateInvestigationOutput = (
  output: string,
  diagnosticLinks: string[],
  bugFields: Record<string, unknown> | undefined,
  roots: Array<{ alias: string; path: string }>,
): InvestigationResult => requireExistingPlannedFiles(
  requireConcretePlannedFiles(parseInvestigation(output, diagnosticLinks, bugFields)),
  roots,
);

/** 合并多段证据，仅供无工具收尾提示与失败证据使用。
 *  绝不能把合并文本当解析输入：后一段轨迹可能已经否定前一段文本里的 JSON 结论。
 *  每段单独限长，避免重复嵌套与超长提示；内容已被更早来源完整包含的段落会跳过。 */
export const mergeInvestigationEvidence = (
  parts: Array<{ label: string; text: string; limit?: number }>,
): string => {
  const kept: Array<{ label: string; text: string }> = [];
  for (const part of parts) {
    const text = part.text.trim();
    if (!text || kept.some((item) => item.text.includes(text))) continue;
    kept.push({ label: part.label, text: compactInvestigationTrace(text, part.limit ?? 6000) });
  }
  return kept.map((item) => `# ${item.label}\n${item.text}`).join("\n\n");
};

interface GitAttempt {
  config: AdditionalDirConfig;
  workspace: GitWorkspace;
  session: GitBranchSession;
  finalized?: GitFinalizeResult;
  settled?: boolean;
}

/** 递归把 BigInt 转 number（SQLite safeIntegers 下 INTEGER 列返回 BigInt，JSON.stringify 无法序列化）。
 *  仅供 web 输出前清洗内部数值列（attempts / 事件自增 id / changelist 等）；bug_id 等大整数已在源头转字符串。 */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

export class Worker {
  config: Config;
  store: StateStore;
  currentBugId: string | null = null;
  cancelEvent = new CancelEvent();

  private clients: Record<string, TapdBackend> = {};
  private lastFetch = 0;
  private lastFetchResult: Bug[] | null = null;
  /** 最近一次“我的 Bug”列表是否完整成功；失败时不能把空壳直拉结果判成单据不存在。 */
  private lastFetchReliable = true;
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;
  private wakeResolvers: Array<() => void> = [];
  private cleanP4Baselines = new Set<string>();
  /** 上一次进入冷却时的截止时间；用于在冷却自然结束时只落一条「已恢复」事件。 */
  private lastProviderCooldownUntil = 0;
  /** 当前处理阶段（管理台「处理中 N」分组标题栏展示「当前阶段」；null = 未领取任务）。 */
  private currentStage: WorkerStage | null = null;
  /** 当前阶段实际生效的模型（随阶段切换与角色配置实时更新，不在管理台里写死）。 */
  private currentStageModel = "";

  private async mediaInputsForBug(bug: Bug): Promise<AgentMediaInput[]> {
    const started = Date.now();
    this.store.addEvent("TAPD: 开始解析描述及附件中的图片/视频 URL", "debug", bug.id);
    try {
      const client = this.tapd(this.workspaceOf(bug));
      const signal = AbortSignal.timeout(45_000);
      const media = client.resolveMediaInputs
        ? await client.resolveMediaInputs(bug, { signal })
        : [];
      if (media.length) {
        this.store.addEvent(
          `TAPD: 已解析 ${media.filter((item) => item.kind === "image").length} 个图片 URL、${media.filter((item) => item.kind === "video").length} 个视频 URL，将作为多模态输入发送（耗时 ${Math.round((Date.now() - started) / 1000)}s）`,
          "info",
          bug.id,
        );
      } else {
        this.store.addEvent(
          `TAPD: 未发现可发送的图片/视频 URL，继续文本调查（耗时 ${Math.round((Date.now() - started) / 1000)}s）`,
          "debug",
          bug.id,
        );
      }
      return media;
    } catch (error) {
      this.store.addEvent(`TAPD: 多媒体 URL 解析失败，继续使用文本描述: ${(error as Error).message}`, "warn", bug.id);
      return [];
    }
  }

  constructor(config: Config, store: StateStore) {
    this.config = config;
    this.store = store;
  }

  // ------------------------------------------------------------------
  // 控制 API（web 调用）
  // ------------------------------------------------------------------
  start(): string {
    this.cancelEvent = new CancelEvent();
    this.store.setControl("running");
    this.store.addEvent("已开启自动处理");
    this.wake();
    return this.store.getControl();
  }

  pause(): string {
    this.cancelEvent.set(); // 中断正在跑的 agent（若有），下轮循环停在 paused
    this.store.setControl("paused");
    this.store.addEvent("已暂停（当前 bug 处理被中断，恢复后回到队列）");
    return this.store.getControl();
  }

  resume(): string {
    return this.start();
  }

  stop(): string {
    this.cancelEvent.set(); // 中断正在跑的 agent（若有）
    this.store.setControl("stopped");
    this.store.addEvent("已关闭自动处理");
    this.wake();
    return this.store.getControl();
  }

  get state(): string {
    return this.store.getControl();
  }

  // ------------------------------------------------------------------
  // 工作循环（单线程 async，用 setTimeout 模拟 Python 的 Event.wait）
  // ------------------------------------------------------------------
  startLoop(): void {
    if (this.loopTask) return;
    this.loopTask = this.runLoop();
  }

  /**
   * 进程启动对账：上个进程崩溃/重启时可能把 bug 留在 in_progress（本次启动时
   * 本进程尚未处理任何 bug，因此所有 in_progress 都必然是遗留僵尸）。全部回退为
   * pending，避免 worker 对 in_progress 防重入而永远不再处理它们（管理台里表现为
   * 「处理中」却无任何进度输出）。
   */
  private reconcileStaleInProgress(): void {
    // Retired admission category: requeue only jobs blocked before producing a candidate.
    for (const job of this.store.listJobs("manual_review")) {
      if (job.changelist || Number(job.attempts ?? 0) !== 0
          || !String(job.failure_reason ?? "").startsWith("涉及高风险领域，必须人工确认:")) continue;
      const id = String(job.bug_id);
      this.store.updateJob(id, {
        agent_state: "pending", failure_reason: null, admission_score: null,
        started_at: null, finished_at: null,
      });
      this.store.addEvent("已移除关键词准入分类，任务恢复待处理", "info", id);
    }
    this.recoverMisclassifiedProviderBlocks();
    for (const job of this.store.listJobs("in_progress")) {
      const id = String(job.bug_id);
      this.store.updateJob(id, { agent_state: "pending", started_at: null });
      this.store.addEvent(
        `上次进程遗留的处理中任务已回退为待处理（进程启动对账）`,
        "info",
        id,
      );
    }
    // 旧版本曾把纯 Agent 超时/工具预算错误归类为 needs_info。它并不代表工单缺信息，
    // 升级后恢复到队列，按“已有证据强制收敛 + 自动重试”的新策略处理。
    for (const job of this.store.listJobs("needs_info")) {
      const reason = String(job.failure_reason ?? "");
      if (!/(?:Agent 调用超时\(\d+s\)|Agent 命令调用超过预算|同一 Agent 命令重复超过|已停止无效搜索\/读取)/.test(reason)) continue;
      const id = String(job.bug_id);
      this.store.updateJob(id, {
        agent_state: "pending",
        failure_reason: null,
        started_at: null,
        finished_at: null,
      });
      this.store.addEvent("旧版本误标为需补充信息的 Agent 超时/预算任务已恢复为待处理", "info", id);
    }
  }

  /** 恢复被旧版本误标为 blocked_workspace 的 provider 故障任务（幂等）。
   *  blocked_workspace 是终态：既不消耗 attempts 也无法自动重试，一次配额耗尽就会让整批
   *  工单卡死。仅当三个条件同时成立才恢复：
   *   1) 失败原因是显式 provider 错误（见 isRecoverableProviderBlock，排除任何 Git/P4/cleanup 证据）；
   *   2) 该单没有产出 changelist——已有候选产物的记录不能当没发生过；
   *   3) 恢复前把原 failure_reason 写进事件，作为审计记录留痕。
   *  启动对账（runLoop）与一次性批处理（runBatch）都会调用：CLI 也必须能自愈这些历史误判。
   *  刻意不在这里碰 in_progress：那可能与正在 serve 的进程抢任务。 */
  recoverMisclassifiedProviderBlocks(): number {
    let recovered = 0;
    for (const job of this.store.listJobs("blocked_workspace")) {
      if (job.changelist !== null && job.changelist !== undefined) continue;
      const reason = String(job.failure_reason ?? "");
      if (!isRecoverableProviderBlock(reason)) continue;
      const id = String(job.bug_id);
      this.store.updateJob(id, {
        agent_state: "pending",
        failure_reason: null,
        started_at: null,
        finished_at: null,
      });
      this.store.addEvent(
        "历史误判为工作区阻塞的 provider 不可用任务已恢复为待处理（未消耗修复尝试）；"
          + `原失败原因: ${reason.slice(0, 300)}`,
        "info",
        id,
      );
      recovered += 1;
    }
    if (recovered) {
      this.store.addEvent(`对账：已恢复 ${recovered} 个被误判为工作区阻塞的 provider 任务`, "info");
    }
    return recovered;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), ms);
      this.wakeResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private wake(): void {
    const resolvers = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of resolvers) r();
  }

  private async runLoop(): Promise<void> {
    this.reconcileStaleInProgress(); // 进程级对账：清理上个进程遗留的 in_progress 僵尸
    while (!this.stopRequested) {
      if (this.store.getControl() === "running") {
        const cooldown = this.store.activeProviderCooldown();
        if (cooldown) {
          // 冷却期内不空转：直接睡到冷却到期（单次休眠有上限，便于感知人工提前解除）。
          this.lastProviderCooldownUntil = cooldown.until_ms;
          const remaining = cooldown.until_ms - Date.now();
          await this.sleep(Math.max(1000, Math.min(remaining, _PROVIDER_COOLDOWN_SLEEP_MAX_MS)));
          continue;
        }
        if (this.lastProviderCooldownUntil) {
          // 冷却自然到期：只落一条恢复事件，不重复刷屏。
          this.lastProviderCooldownUntil = 0;
          this.store.addEvent("provider 冷却已结束，恢复自动处理", "info");
        }
        let processed = false;
        try {
          processed = await this.processNext();
        } catch (exc) {
          // 兜底，避免循环死掉
          this.store.addEvent(`工作循环异常: ${exc}`, "error");
          processed = false;
        }
        await this.sleep(processed ? 3000 : 10000);
      } else {
        await this.sleep(2000);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopRequested = true;
    this.wake();
    if (this.loopTask) await this.loopTask;
  }

  /** 清空已缓存的 tapd 客户端，让设置页改动的 tapd 凭据/backend 立即生效（下次拉取重建）。 */
  resetTapdClients(): void {
    this.clients = {};
    this.lastFetch = 0;
    this.lastFetchResult = null;
    this.lastFetchReliable = true;
  }

  // ------------------------------------------------------------------
  // 队列
  // ------------------------------------------------------------------
  private tapd(ws: WorkspaceConfig): TapdBackend {
    const backend = String((this.config.tapd as Record<string, unknown>).backend ?? "rest");
    const key = backend === "mcp" ? `mcp:${ws.workspace_id}` : ws.workspace_id;
    if (!this.clients[key]) {
      this.clients[key] = createTapdClient(this.config, ws.workspace_id);
    }
    return this.clients[key];
  }

  private workspaceOf(bug: Bug): WorkspaceConfig {
    const ws = this.config.workspaces.find((w) => w.workspace_id === bug.workspace_id);
    return ws ?? this.config.workspaces[0];
  }

  /** 从本地 job 行重建 Bug 快照（title/priority 等在 upsertJob 时已落库）。
   *  用于已不在 Tapd「分配给我」列表里的 bug：它们仍要可见、可重试、可处理，
   *  否则人工点重试后既看不到行、worker 也永远不领——表现为「重试没生效」。 */
  private bugFromJobSnapshot(job: Record<string, unknown>): Bug {
    const id = String(job.bug_id);
    return {
      id,
      workspace_id: String(job.workspace_id ?? this.config.workspaces[0]?.workspace_id ?? ""),
      title: String(job.title ?? `Bug ${id}`),
      description: "",
      status: String(job.tapd_status ?? ""),
      priority: String(job.priority ?? ""),
      priority_label: String(job.priority_label ?? ""),
      severity: "",
      module: "",
      current_owner: "",
      reporter: "",
      created: String(job.started_at ?? ""),
      raw: {},
    };
  }

  /** 按 id 直拉单个 bug，区分三种结果：
   *  - found：Tapd 返回真实数据（在「我的」列表或直拉成功且非空壳）
   *  - missing：Tapd 确认无此单 —— REST/MCP 对不存在的 id 都返回「只有 id 的空壳」
   *    （无标题无状态），以此与真实单区分（Tapd 真实单必有标题）
   *  - unknown：接口异常（网络/鉴权波动），无法判断，调用方不得据此丢弃任务 */
  private async fetchBugVerbose(
    bugId: string,
  ): Promise<{ kind: "found"; bug: Bug } | { kind: "missing" } | { kind: "unknown" }> {
    const inList = (await this.fetchMyBugs()).find((b) => b.id === bugId);
    if (inList) return { kind: "found", bug: inList };
    const listReliable = this.lastFetchReliable;
    try {
      const ws = this.config.workspaces[0];
      const bug = await this.tapd(ws).getBug(bugId);
      if (!bug.title.trim() && !bug.status.trim()) {
        // MCP 在上游 fetch 失败时可能也返回“只有 id 的空壳”，与真正不存在的单据形态相同。
        // 只有列表查询本身成功时，才有足够证据把空壳判为 missing；否则保守保持 pending。
        return listReliable ? { kind: "missing" } : { kind: "unknown" };
      }
      return { kind: "found", bug };
    } catch {
      return { kind: "unknown" };
    }
  }

  /** 获取人工操作和详情页所需的 Bug；不存在时返回 null。 */
  private async fetchBugForManual(bugId: string): Promise<Bug | null> {
    const res = await this.fetchBugVerbose(bugId);
    return res.kind === "found" ? res.bug : null;
  }

  /** 本地 job → 可处理的 Bug。Tapd 上已确认不存在时自动转 skipped（留痕）并返回 null。 */
  private async bugFromJob(job: Record<string, unknown>): Promise<Bug | null> {
    const snapshot = this.bugFromJobSnapshot(job);
    const res = await this.fetchBugVerbose(snapshot.id);
    if (res.kind === "found") return res.bug;
    if (res.kind === "missing") {
      // Tapd 已无此单（删除/转移工作区）：没有描述的快照不值得喂给 agent，
      // 自动跳过并留痕；本地记录保留（changelist/失败证据仍在管理台可见）
      this.store.updateJob(snapshot.id, {
        agent_state: "skipped",
        failure_reason: "Tapd 单已不存在（可能已删除或转移），自动跳过",
        finished_at: nowStr(),
      });
      this.store.addEvent(
        "Tapd 上已不存在该 bug（可能已删除或转移工作区），自动跳过处理",
        "warn",
        snapshot.id,
      );
      return null;
    }
    return snapshot; // unknown（接口波动）：用快照留在队列，下次轮询再确认
  }

  private async fetchMyBugs(): Promise<Bug[]> {
    const now = Date.now();
    if (this.lastFetchResult !== null && now - this.lastFetch < _FETCH_CACHE_MS) {
      return this.lastFetchResult;
    }
    const bugs: Bug[] = [];
    let reliable = true;
    for (const ws of this.config.workspaces) {
      try {
        const fetched = await this.tapd(ws).listBugs(ws.owner);
        for (const b of fetched) b.workspace_id = ws.workspace_id;
        bugs.push(...fetched);
      } catch (exc) {
        reliable = false;
        this.store.addEvent(`workspace ${ws.workspace_id} 拉取失败: ${exc}`, "error");
      }
    }
    this.lastFetch = now;
    this.lastFetchResult = bugs;
    this.lastFetchReliable = reliable;
    return bugs;
  }

  /** 分配给我的、未处理的 bug，按优先级排序（数字小优先，再按创建时间）。
   *  除 Tapd「我的」列表外，还并入本地 pending 但已不在该列表的 bug（改派/翻页遗漏/
   *  接口波动）：人工重试后必须仍会被处理。Tapd 侧已终态（resolved/closed 等）的不复活。 */
  async fetchActionable(): Promise<Bug[]> {
    // 全局 provider 冷却期内不领任何任务：同一个不可用的 provider 不该被整批工单轮流撞。
    // 闸门放在这里（而不是只在 processBug 内），runLoop 与 CLI runBatch 走的是同一条路。
    if (this.store.activeProviderCooldown()) return [];
    const bugs = await this.fetchMyBugs();
    const actionable: Bug[] = [];
    const seen = new Set<string>();
    for (const b of bugs) {
      seen.add(b.id);
      if (this.config.exclude_status.includes(b.status)) continue;
      const job = this.store.getJob(b.id);
      if (job?.agent_state && _TERMINAL_STATES.has(String(job.agent_state))) continue; // 终态不自动重试
      if (job?.agent_state === "in_progress") continue; // 正在处理（防重入）
      actionable.push(b);
    }
    // 本地记录里非终态、可自动重试、但已不在 Tapd「我的」列表的单（改派/翻页遗漏/接口波动）
    // 也要继续处理。provider_unavailable 必须一并纳入：它是非终态，但不在第一个循环的
    // 候选里，若只补 pending，一个不在 Tapd 列表里的 provider 故障单在冷却结束后会永远
    // 领不回来（表现为点了重试也没反应）。
    for (const job of [
      ...this.store.listJobs("pending"),
      ...this.store.listJobs("provider_unavailable"),
    ]) {
      const id = String(job.bug_id);
      if (seen.has(id)) continue;
      if (this.config.exclude_status.includes(String(job.tapd_status ?? ""))) continue; // 快照终态不复活
      const bug = await this.bugFromJob(job); // Tapd 已确认无此单时这里会自动转 skipped
      if (!bug) continue;
      if (this.config.exclude_status.includes(bug.status)) continue; // Tapd 直拉到终态也不复活
      actionable.push(bug);
    }
    actionable.sort((a, b) => {
      const byPriority = priorityRank(this.config, a) - priorityRank(this.config, b);
      if (byPriority !== 0) return byPriority;
      return (a.created || "").localeCompare(b.created || "");
    });
    return actionable.slice(0, this.config.max_bugs_per_run);
  }

  async processNext(): Promise<boolean> {
    const bugs = await this.fetchActionable();
    if (!bugs.length) return false;
    const bug = bugs[0];
    this.currentBugId = bug.id;
    try {
      await this.processBug(bug);
    } finally {
      this.currentBugId = null; // processBug 负责清空阶段展示，这里只管「当前 bug」
    }
    return true;
  }

  /** 同步处理一批（CLI 用，忽略控制态）。 */
  async runBatch(limit?: number): Promise<number> {
    // CLI 一次性批处理也要能自愈历史误判的 provider 阻塞（幂等，只动 blocked_workspace）。
    this.recoverMisclassifiedProviderBlocks();
    const n = limit ?? this.config.max_bugs_per_run;
    let count = 0;
    while (count < n) {
      if (!(await this.processNext())) break;
      count += 1;
    }
    return count;
  }

  // ------------------------------------------------------------------
  // 单个 bug 处理
  // ------------------------------------------------------------------
  private resolveRepo(bug: Bug): RepoConfig | undefined {
    const ws = this.workspaceOf(bug);
    const repos = ws.repos;
    if (!repos.length) return undefined;
    if (repos.length === 1) return repos[0];
    if (ws.default_repo) {
      const r = repos.find((r) => r.name === ws.default_repo);
      if (r) return r;
    }
    const mod = (bug.module ?? "").toLowerCase();
    for (const r of repos) {
      if (r.name.toLowerCase().includes(mod) || mod.includes(r.name.toLowerCase())) return r;
    }
    this.store.addEvent(`仓库映射未精确匹配，使用第一个仓库 ${repos[0].name}`, "warn", bug.id);
    return repos[0];
  }

  private workspaceRoots(repo: RepoConfig) {
    return [
      { alias: "project", name: repo.name, path: repo.path, vcs: "p4" as const },
      ...(repo.additional_dirs ?? []).map((dir) => ({
        alias: dir.name.toLowerCase(), name: dir.name, path: dir.path, vcs: "git" as const,
      })),
    ];
  }

  private additionalPaths(repo: RepoConfig): string[] {
    return (repo.additional_dirs ?? []).map((dir) => dir.path);
  }

  private plannedRoots(plannedFiles: string[]): Set<string> {
    return new Set(plannedFiles.map((file) => {
      const normalized = file.trim().replace(/\\/g, "/");
      const separator = normalized.indexOf(":");
      return (separator >= 0 ? normalized.slice(0, separator) : "project").toLowerCase();
    }));
  }

  private verificationCommands(repo: RepoConfig, plannedFiles?: string[]): string[] {
    const plannedRoots = this.plannedRoots(plannedFiles ?? []);
    return [
      ...(!plannedFiles || plannedRoots.has("project")
        ? repo.verify_cmds.map((command) => `[project] ${formatVerificationCommand(command)}`)
        : []),
      ...(repo.additional_dirs ?? []).flatMap((dir) =>
        plannedFiles && !plannedRoots.has(dir.name.toLowerCase())
          ? []
          : dir.verify_cmds.map((command) => `[${dir.name.toLowerCase()}] ${formatVerificationCommand(command)}`)),
    ];
  }

  private async prepareGitAttempts(
    repo: RepoConfig,
    ws: WorkspaceConfig,
    plannedFiles: string[],
    bugId?: string,
  ): Promise<GitAttempt[]> {
    const attempts: GitAttempt[] = [];
    const additionalDirs = repo.additional_dirs ?? [];
    const plannedRoots = this.plannedRoots(plannedFiles);
    const selectedDirs = additionalDirs.filter((config) =>
      plannedRoots.has(config.name.toLowerCase()));
    if (additionalDirs.length && !selectedDirs.length) {
      this.store.addEvent(
        "调查计划不涉及 Git 引擎代码，本 Bug 不创建 Git 分支",
        "info",
        bugId ?? this.currentBugId ?? undefined,
      );
    }
    try {
      for (const config of selectedDirs) {
        this.store.addEvent(
          `Git ${config.name}: 开始检查附加仓库（${config.path}，基线 ${config.base_branch}）`,
          "info",
          bugId ?? this.currentBugId ?? undefined,
        );
        const workspace = new GitWorkspace(config.path, config.ignore_paths ?? []);
        const author = config.author.trim() || String(this.config.p4.user ?? "").trim() || ws.owner.trim();
        const session = await workspace.prepareBranch(config.base_branch, author);
        attempts.push({ config, workspace, session });
        this.store.addEvent(
          `Git ${config.name}: 仓库连接及状态检查成功，已创建分支 ${session.branch}`,
          "info",
          bugId ?? this.currentBugId ?? undefined,
        );
        if (config.ignore_paths?.length) {
          this.store.addEvent(
            `Git ${config.name}: 已忽略本地生成路径 ${config.ignore_paths.join(", ")}`,
            "info",
            bugId ?? this.currentBugId ?? undefined,
          );
        }
      }
      return attempts;
    } catch (error) {
      for (const attempt of attempts.reverse()) {
        try { await attempt.workspace.rollback(attempt.session); } catch { /* 保留原始异常 */ }
      }
      if (error instanceof GitWorkspaceError) throw new WorkspaceBlockedError(error.message);
      throw error;
    }
  }

  private async rollbackGitAttempts(attempts: GitAttempt[]): Promise<void> {
    const failures: string[] = [];
    for (const attempt of [...attempts].reverse()) {
      try {
        if (attempt.settled && !attempt.finalized) continue;
        if (attempt.finalized) {
          await attempt.workspace.discardFinalized(attempt.session, attempt.finalized);
        } else {
          await attempt.workspace.rollback(attempt.session);
        }
      } catch (error) {
        failures.push(`${attempt.config.name}: ${String(error)}`);
      }
    }
    if (failures.length) throw new WorkspaceBlockedError(`Git 自动分支清理失败: ${failures.join("；")}`);
  }

  /** 评审驱动的受控范围补充：只扩充「本次有效计划范围」，不放宽 verifyCandidate 的范围门禁。
   *  评审明确指向（findings 的位置/必须修正项，以及阻断性 finding 的举证）且能安全解析到配置根内
   *  已有具体文件的需求会被加入 planned_files；显式根别名却定位不到、或超过 quality.max_changed_files
   *  的要求一律转人工阻塞（不消耗模型重试，也不进入注定失败的修正轮）。
   *  writtenFiles 存在时只审批 Agent 实际写入、且被评审指名的计划外文件（correction 结果后的兜底）。 */
  private applyReviewScopeAmendment(
    bug: Bug,
    investigation: InvestigationResult,
    review: ReviewResult,
    repo: RepoConfig,
    auditAttemptId: string,
    stage: "correction" | "verification",
    writtenFiles?: string[],
  ): { investigation: InvestigationResult; added: string[] } {
    const roots = this.workspaceRoots(repo);
    const limit = this.config.quality.max_changed_files;
    const amendment = writtenFiles?.length
      ? reviewScopeAmendmentForWritten(review, roots, investigation, limit, writtenFiles)
      : reviewScopeAmendment(review, roots, investigation, limit);
    const detail = {
      source: "review",
      stage,
      limit,
      requested: amendment.requested.slice(0, 40),
      approved: amendment.approved,
      unapprovable: amendment.unapprovable.slice(0, 20),
      unresolved: amendment.unresolved.slice(0, 40),
      reason: amendment.reason || null,
    };
    if (amendment.requested.length) {
      this.store.audit.event(auditAttemptId, "scope_amendment_requested", detail);
    }
    if (amendment.unapprovable.length) {
      this.store.audit.event(auditAttemptId, "scope_amendment_rejected", detail);
      throw new WorkspaceBlockedError(
        `独立代码评审要求修改计划范围外的文件，但无法安全纳入本次自动修复范围（`
        + `${amendment.reason ? `${amendment.reason}；` : ""}计划文件上限 ${limit}）: `
        + `${amendment.unapprovable.join(", ")}；已转人工确认修改范围，不再进入无解的自动重试。`,
      );
    }
    if (!amendment.approved.length) return { investigation, added: [] };
    const previous = investigation.planned_files;
    const amended: InvestigationResult = {
      ...investigation,
      planned_files: [...previous, ...amendment.approved],
    };
    this.store.audit.event(auditAttemptId, "scope_amendment_approved", {
      ...detail, previous_files: previous, planned_files: amended.planned_files,
    });
    this.store.addEvent(
      `评审要求的计划外文件已通过受控范围补充纳入本次计划范围: ${amendment.approved.join(", ")}`
      + `（计划文件 ${previous.length} → ${amended.planned_files.length}，上限 ${limit}）`,
      "warn",
      bug.id,
    );
    this.store.updateJob(bug.id, { investigation: amended });
    return { investigation: amended, added: amendment.approved };
  }

  private async verifyCandidate(
    p4: P4Client,
    repo: RepoConfig,
    gitAttempts: GitAttempt[],
    opened?: OpenedFile[] | null,
    plannedFiles?: string[],
    reportedFiles: string[] = [],
    auditAttemptId?: string,
    behaviorChecks: FrozenBehaviorCheck[] = [],
  ): Promise<{ opened: OpenedFile[]; gitFiles: string[]; diff: string; summary: string; verified: boolean; behavior: BehaviorVerification; pipelines: unknown[] }> {
    // 计划文件已预打开，仍需登记 Agent 实际写入的其它精确路径，再由范围门拒绝越界。
    const targets = p4ReconcileTargets([...(plannedFiles ?? []), ...reportedFiles]);
    const preview = await p4.reconcilePreview(targets);
    if (preview.trim()) {
      await p4.reconcile(preview);
      opened = await p4.opened("default", true);
    }
    let actualOpened = opened?.length ? opened : [];
    if (!actualOpened.length) {
      const p4Opened = await p4.opened("default");
      if (p4Opened.length) {
        actualOpened = p4Opened;
      } else {
        const reconcileTargets = p4ReconcileTargets(plannedFiles ?? []);
        const p4Preview = await p4.reconcilePreview(reconcileTargets);
        if (p4Preview.trim()) {
          actualOpened = await checkAndPrepareP4(p4, reconcileTargets);
        } else {
          const elsewhere = (await p4.opened()).filter((item) => item.changelist !== "default");
          if (elsewhere.length) {
            throw new VerificationError(
              `Agent 把文件打开到了编号 changelist: ${elsewhere.map((item) => item.depot).join(", ")}`,
            );
          }
        }
      }
    }
    const gitChanges = await Promise.all(gitAttempts.map(async (attempt) => ({
      attempt,
      files: await attempt.workspace.changedFiles(attempt.session.baseCommit),
      diff: await attempt.workspace.diff(attempt.session.baseCommit),
    })));
    const rootedP4Files = actualOpened.map((item) => `project:${item.depot}`);
    const rootedGitFiles = gitChanges.flatMap(({ attempt, files }) =>
      files.map((file) => `${attempt.config.name.toLowerCase()}:${file}`));
    const allFiles = [...rootedP4Files, ...rootedGitFiles];
    if (!allFiles.length) throw new VerificationError("Agent 未在 P4 或 Git 工作目录产生任何代码改动");
    const p4Diff = actualOpened.length
      ? await p4.candidateDiff(actualOpened)
      : "";
    const diff = [
      p4Diff ? `### project (Perforce)\n${p4Diff}` : "",
      ...gitChanges.filter((item) => item.diff).map(({ attempt, diff: gitDiff }) =>
        `### ${attempt.config.name.toLowerCase()} (Git: ${attempt.session.branch})\n${gitDiff}`),
    ].filter(Boolean).join("\n\n");
    if (auditAttemptId) this.store.audit.event(auditAttemptId, "patch", { diff, files: allFiles });
    if (auditAttemptId && plannedFiles) this.store.audit.event(auditAttemptId, "source_candidate", { files: sourceEvidence(plannedFiles, this.workspaceRoots(repo)) });
    if (plannedFiles) {
      const plannedScope = assessPlannedScope(
        allFiles,
        plannedFiles,
      );
      if (!plannedScope.ok) {
        throw new VerificationError(
          "实际修改超出调查阶段计划范围: " + plannedScope.unplanned_files.join(", "),
        );
      }
    }
    if (!hasPatchEvidence(diff)) throw new VerificationError("未取得真实非空补丁，不能交付候选");
    const scope = assessPatchScope(
      allFiles,
      diff,
      this.config.quality.max_changed_files,
      this.config.quality.max_diff_lines,
    );
    if (!scope.ok) throw new VerificationError(scope.reasons.join("；"));
    const pipelines: Array<{
      name: string;
      result: Awaited<ReturnType<typeof runVerificationPipeline>>;
    }> = [];
    if (actualOpened.length) {
      pipelines.push({ name: "project", result: await runVerificationPipeline(
        repo.path, repo.verify_cmds, this.config.quality.require_verification,
      ) });
    }
    for (const attempt of gitAttempts) {
      const changed = gitChanges.find((item) => item.attempt === attempt);
      if (!changed?.files.length) continue;
      pipelines.push({
        name: attempt.config.name.toLowerCase(),
        result: await runVerificationPipeline(
          attempt.config.path,
          attempt.config.verify_cmds,
          this.config.quality.require_verification,
        ),
      });
    }
    const failed = pipelines.find(({ result }) => !result.ok);
    if (auditAttemptId) this.store.audit.event(auditAttemptId, "verification", { pipelines });
    if (failed) {
      throw new Error(`测试未通过 (${failed.name}): ${failed.result.summary.slice(-1000)}`);
    }
    const behavior = await verifyBehaviorChecks(behaviorChecks, repo.path, this.cancelEvent);
    if (auditAttemptId) this.store.audit.event(auditAttemptId, "behavior_verification", { ...behavior });
    if (!behavior.ok) throw new VerificationError("业务行为测试未通过: " + JSON.stringify(behavior.checks));
    return {
      opened: actualOpened,
      gitFiles: rootedGitFiles,
      diff,
      summary: pipelines.map(({ name, result }) => `[${name}][配置的构建/测试命令] ${result.summary}`).join("\n")
        + `\n行为验证: ${behavior.level === "L1" ? "L1 目标复现及对照通过" : "待验收"}\n${behavior.unverified_items.join("\n")}`,
      verified: pipelines.every(({ result }) => result.ok && result.configured),
      behavior, pipelines,
    };
  }

  /** 检查真实改动；只关闭内容未变的 edit，不撤销补丁，也不运行测试。 */
  private async hasImplementationChanges(
    p4: P4Client,
    gitAttempts: GitAttempt[],
    plannedFiles: string[],
  ): Promise<boolean> {
    // p4 diff -du 对未修改的已打开文件也会输出 ==== ... ==== 标题。
    // 先关闭这些预打开文件，不能把标题非空当作真实补丁。
    let opened = await p4.opened("default", true);
    const edits = opened.filter((item) => item.action === "edit").map((item) => item.depot);
    if (edits.length) {
      await p4.revertUnchanged(edits);
      opened = await p4.opened("default", true);
    }
    if (opened.length) return true;
    if ((await p4.reconcilePreview(p4ReconcileTargets(plannedFiles))).trim()) return true;
    for (const attempt of gitAttempts) {
      if ((await attempt.workspace.changedFiles(attempt.session.baseCommit)).length) return true;
    }
    return false;
  }

  private async reviewCandidate(
    reviewer: PiAgent,
    reviewerModel: string,
    p4: P4Client,
    bug: Bug,
    investigation: InvestigationResult,
    diff: string,
    verificationSummary: string,
    additionalDirs: string[],
    media: AgentMediaInput[] = [],
    requiredMcpServers: string[] = [],
  ): Promise<ReviewResult> {
    const reviewPrompt = buildReviewPrompt({ bug, investigation, diff, verificationSummary });
    const auditAttempt = this.store.audit.attempts(bug.id).at(-1);
    if (auditAttempt) this.store.audit.event(auditAttempt.attempt_id, "review_input", { prompt_hash: evidenceHash(reviewPrompt), diff_hash: evidenceHash(diff), model: reviewerModel, role: "review" });
    // 角色时限：agents.roles.review.timeout_s 存在时以它为准，否则沿用 agent_timeout_s（改造前行为）。
    const reviewTimeoutS = agentRoleTimeoutS(this.config, "review", this.config.agent_timeout_s);
    const result = await reviewer.run({
      prompt: reviewPrompt,
      repoDir: p4.path,
      additionalDirs,
      role: "review",
      timeoutS: reviewTimeoutS,
      tools: ["read", "grep", "find", "ls"],
      maxCommandExecutions: _REVIEW_COMMAND_BUDGET,
      repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
      sandboxMode: "read-only",
      model: reviewerModel || undefined,
      requiredMcpServers,
      cancelEvent: this.cancelEvent,
      onProgress: (msg) => this.store.addEvent(`Reviewer ${msg}`, "debug", bug.id),
      onAudit: event => { if (auditAttempt) this.store.audit.event(auditAttempt.attempt_id, "agent", { phase: "review", ...event }); },
      media,
    });
    if (!result.ok) {
      throw new VerificationError(`Reviewer 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
    }
    const raw = result.raw_output || result.log || result.summary;
    const review = parseReviewResult(raw);
    if (auditAttempt) this.store.audit.event(auditAttempt.attempt_id, "review_output", { raw, review });
    return review;
  }

  /**
   * 进程在写入后被强杀时，finally 无法登记 last_attempt_files。若事件历史能证明
   * default 中的全部文件都由同一个旧任务写入，则把它们保留到独立 pending CL，
   * 避免既丢代码、又让后续所有 Bug 永久停在“工作区待清理”。
   */
  private async preserveCrashOrphans(
    p4: P4Client,
    depotFiles: string[],
    currentBugId: string,
  ): Promise<boolean> {
    if (!depotFiles.length) return false;
    const owners = this.store.listJobs("all").filter((job) => {
      const id = String(job.bug_id);
      if (id === currentBugId) return false;
      const events = this.store.listEvents(id, 2000);
      return depotFiles.every((depot) => events.some((event) =>
        /^Agent: (?:edit|write)\s+/i.test(String(event.msg ?? ""))
          && this.trackedPathMatchesDepot(
            String(event.msg ?? "").replace(/^Agent: (?:edit|write)\s+/i, ""),
            depot,
            p4,
          )));
    });
    if (owners.length !== 1) return false;

    const owner = owners[0];
    const ownerId = String(owner.bug_id);
    const diff = await p4.diffUnified(depotFiles);
    if (!diff.trim()) return false;
    const desc = [
      `【b${ownerId}】${String(owner.title ?? `恢复 Bug ${ownerId} 的中断改动`)}`,
      "",
      "TapdBugFixAgent 检测到上次进程在写入后异常中断。",
      "以下改动已从 default changelist 隔离保存，未标记为自动修复成功，请人工 review。",
    ].join("\n");
    const cl = await p4.createPending(desc, depotFiles);
    this.store.updateJob(ownerId, {
      agent_state: "manual_review",
      changelist: cl,
      files: dumps(depotFiles.map((file) => `project:${file}`)),
      failure_reason: "进程在写入后异常中断；候选改动已恢复并隔离，等待人工评审",
      last_attempt_files: null,
      finished_at: nowStr(),
    });
    this.store.addEvent(
      `检测到进程中断遗留的 ${depotFiles.length} 个文件，已保留到 pending changelist ${cl}`,
      "warn",
      ownerId,
    );
    this.store.addEvent(
      `已自动归属并隔离旧任务 ${ownerId} 的 default 遗留文件，当前任务可继续`,
      "info",
      currentBugId,
    );
    return true;
  }

  async processBug(bug: Bug): Promise<void> {
    // 双保险：全局 provider 冷却期间不得开始任何新尝试。fetchActionable 已拦一层，
    // 但批量入口（CLI runBatch 等）可能持有提前取好的快照，所以在真正的执行入口再查一次，
    // 绝不把工单喂给已知不可用的 provider。
    if (this.store.activeProviderCooldown()) return;
    // 记录本次尝试开始时的 generation：如果尝试期间人工点过「重试」（明确解除冷却），
    // 那么迟到的 provider 错误不得再把冷却重新打开，否则用户点了重试却仍然没有反应。
    const cooldownEpochAtStart = this.store.providerCooldownEpoch();
    const auditAttemptId = this.store.audit.begin({
      bug_id: bug.id, workspace_id: bug.workspace_id, input: buildBugContext(bug),
      metadata: {
        model: effectivePiModel(this.config.pi), review_model: reviewerModel(this.config),
        agent_roles: agentRoleSnapshot(this.config),
        review_enabled: this.config.review.enabled, quality: this.config.quality,
        agent_timeout_s: this.config.agent_timeout_s, max_attempts: this.config.max_attempts,
        runtime: process.version, agent_code_hashes: runtimeEvidence(),
      },
    });
    this.store.upsertJob(bug, {
      agent_state: "in_progress", started_at: nowStr(), investigation: null, verification: null,
      review_findings: null, generated_description: null, failure_reason: null,
    });
    this.store.addEvent(`开始处理 bug ${bug.id}: ${bug.title}`, "info", bug.id);
    let p4: P4Client | null = null;
    let activeRepo: RepoConfig | null = null;
    let gitAttempts: GitAttempt[] = [];
    let lastResult: AgentResult | null = null;
    let orchestratorOpenedTargets: string[] = [];
    let phase = "preflight";
    this.applyStage("preflight"); // 管理台「处理中 N」分组标题栏立即显示当前阶段（不再猜「跑到哪一步」）
    let contextKey = "";
    let investigationCheckpoint: InvestigationResult | undefined;
    let investigationProgress: InvestigationProgress | undefined;
    let investigationOutput = "";
    let behaviorChecks: FrozenBehaviorCheck[] = [];
    /** coordinator（只读无工具）两处调用的产物：调查前的计划建议、交付前的汇总文案。
     *  两者都只是附加文字：计划进调查 prompt，汇总进交付描述，绝不参与任何决策。 */
    let coordinatorPlanText = "";
    let coordinatorSummary: CoordinatorSummary | null = null;
    try {
      const repo = this.resolveRepo(bug);
      if (!repo) {
        throw new Error("未配置该 bug 对应的仓库映射（workspaces[].repos[]）");
      }
      activeRepo = repo;

      const mcpManualKeywords = configuredManualKeywords(this.config.mcp_servers);
      this.applyStage("admission"); // 准入评估：管理台可见（不通过时也要能看到停在准入）
      const admission = assessFixabilityWithNarrative(
        bug,
        {
          ...this.config.quality.admission,
          manual_keywords: [...new Set([
            ...this.config.quality.admission.manual_keywords,
            ...mcpManualKeywords,
          ])],
        },
        automatableManualKeywords(this.config.mcp_servers),
      );
      this.store.updateJob(bug.id, { admission_score: admission.score });
      if (!admission.eligible) {
        const state = admission.disposition === "manual_only" ? "manual_only" : "needs_info";
        const reason = admission.reasons.join("；") || "自动修复准入未通过";
        this.store.updateJob(bug.id, {
          agent_state: state,
          admission_score: admission.score,
          failure_reason: reason,
          finished_at: nowStr(),
        });
        this.store.addEvent(`自动修复准入未通过（${admission.score} 分）: ${reason}`, "warn", bug.id);
        return;
      }

      // 处理开始时就把 agent / 模型写进 job，web 列表与详情可实时看到
      const model = effectivePiModel(this.config.pi);
      this.store.updateJob(bug.id, { agent: "pi", model });

      const generatedP4Ignore = ensureP4IgnoreFile(repo.path, repo.ignore_paths ?? []);
      if (generatedP4Ignore) this.config.p4.ignore = generatedP4Ignore;
      p4 = new P4Client(
        repo.path,
        this.config.p4,
        (level, message) => this.store.addEvent(message, level, bug.id),
        this.cancelEvent,
        repo.ignore_paths ?? [],
      );
      this.store.addEvent(
        `P4: 开始检查连接与工作区（server=${String(this.config.p4.port ?? "(默认)")}，client=${String(this.config.p4.client ?? "(默认)")}）`,
        "info",
        bug.id,
      );
      if (repo.ignore_paths?.length) {
        this.store.addEvent(
          `P4: 已跳过本地生成路径 ${repo.ignore_paths.join(", ")}`,
          "info",
          bug.id,
        );
      }

      // ---- 重试/恢复：先撤销上一次尝试遗留的打开文件（只撤销 default changelist），从干净工作区开始 ----
      const stale = await this.cleanupStaleAttempt(bug.id, p4);
      if (stale.length) {
        this.store.addEvent(`已撤销上一次尝试遗留的打开文件 ${stale.length} 项`, "warn", bug.id);
      }
      // 其它 Bug 遗留的 default 文件既不能擅自撤销，也绝不能混入当前补丁；阻塞并等待人工清理。
      const defaultOpened = await p4.opened("default", true);
      this.store.addEvent(
        `P4: 连接成功，default changelist 当前打开 ${defaultOpened.length} 个文件`,
        "info",
        bug.id,
      );
      let debris = defaultOpened.map((o) => o.depot).filter((f) => !stale.includes(f));
      if (debris.length && await this.preserveCrashOrphans(p4, debris, bug.id)) {
        debris = (await p4.opened("default", true)).map((item) => item.depot);
      }
      if (debris.length) {
        throw new WorkspaceBlockedError(
          `default changelist 不干净，存在 ${debris.length} 个无法归属当前 Bug 的打开文件；` +
            `请人工清理后重试: ${debris.join(", ").slice(0, 500)}`,
        );
      }
      const baselineKey = repo.path.replace(/\\/g, "/").toLowerCase();
      const preflightMode = repo.preflight_reconcile ?? "never";
      const shouldScan = preflightMode === "always"
        || (preflightMode === "once" && !this.cleanP4Baselines.has(baselineKey));
      if (shouldScan) {
        this.store.addEvent("P4: 开始扫描仓库目录内未登记的本地改动（reconcile -n ./...）", "debug", bug.id);
        const reconcileStarted = Date.now();
        const untrackedChanges = (await p4.reconcilePreview()).trim();
        this.store.addEvent(
          `P4: 本地改动扫描完成（耗时 ${Math.round((Date.now() - reconcileStarted) / 1000)}s）`,
          "info",
          bug.id,
        );
        if (untrackedChanges) {
          throw new WorkspaceBlockedError(
            "工作区存在未登记的本地改动；请人工确认、revert 或归入正确 changelist 后重试: " +
              untrackedChanges.replace(/\s+/g, " ").slice(0, 500),
          );
        }
        if (preflightMode === "once") this.cleanP4Baselines.add(baselineKey);
      } else {
        this.store.addEvent(
          preflightMode === "never"
            ? "P4: 专用工作区已关闭启动前未登记改动扫描"
            : "P4: 专用工作区基线已确认，本次跳过重复 reconcile 扫描",
          "debug",
          bug.id,
        );
      }

      // ---- 带证据的重试：把之前的失败记录压缩成提示，喂给全新上下文的 Agent ----
      const retryEntries = this.retryEvidenceEntries(bug.id);
      const retryText = formatRetryEvidence(retryEntries);
      const investigationMedia = await this.mediaInputsForBug(bug);
      const attempts = Number(this.store.getJob(bug.id)?.attempts ?? 0) + 1;
      const agent = new PiAgent(this.config);
      // 评审模型的唯一入口：agents.roles.review.model > pi.provider 默认模型（旧 review.model 已移除）。
      // 这里解析成最终生效值并贯穿审计与 --model，保证「调用用的模型」与「审计记录的模型」逐字一致。
      const resolvedReviewerModel = reviewerModel(this.config);
      const reviewer = this.config.review.enabled
        ? new PiAgent(this.config)
        : null;
      const mcpServerNames = enabledMcpServerNames(this.config.mcp_servers);
      const bugEvidenceText = [
        admission.context.title,
        admission.context.module,
        admission.context.description,
        admission.context.reproduction_steps,
        admission.context.expected_result,
        admission.context.actual_result,
        ...admission.context.logs,
        ...admission.context.comments,
        ...admission.context.attachments,
      ].join("\n");
      const resourceMcpServers = mcpServerNamesMatchingText(
        this.config.mcp_servers,
        bugEvidenceText,
      );
      const resourceMcpEnabled = resourceMcpServers.length > 0;
      const investigationMcpServers = [...new Set([
        ...(admission.context.diagnostic_links.length ? ["chrome_devtools"] : []),
        ...resourceMcpServers,
      ])];
      const workspaceRoots = this.workspaceRoots(repo);
      contextKey = createHash("sha256").update(JSON.stringify({ context: admission.context, roots: workspaceRoots })).digest("hex");
      const investigationAdditionalDirs = this.additionalPaths(repo);
      if (investigationMcpServers.length) {
        this.store.addEvent(
          `MCP: 本次调查选择：${investigationMcpServers.join(", ")}；其中强制可用：${resourceMcpServers.join(", ") || "无"}`,
          "info",
          bug.id,
        );
      }
      const investigationTimeoutS = mainInvestigationTimeoutS(this.config.agent_timeout_s);
      /** 角色阶段时限（主调用）：agents.roles.<role>.timeout_s 存在时以它为准，
       *  否则沿用该阶段既有的预算；未配置时与改造前逐字一致。 */
      const roleStageTimeout = (role: AgentRole, fallback: number): number =>
        agentRoleTimeoutS(this.config, role, fallback);
      /** 角色派生时限（收尾/补查等）：角色配置同样受既有派生上限约束，不会放大收尾预算。 */
      const roleCappedTimeout = (role: AgentRole, cap: number): number =>
        Math.min(agentRoleTimeoutS(this.config, role, cap), cap);
      this.store.addEvent(
        `调用只读调查 Agent：定位根因、证据与最小修改范围（本阶段时限 ${investigationTimeoutS}s）`,
        "info",
        bug.id,
      );
      // ---- coordinator 计划（只读、无工具）：产出「调查计划建议」，作为调查 prompt 的补充。
      //      只在新调用点被**显式配置**时启用（agents.roles.coordinator）；未配置 = 与改造前逐字一致，
      //      不插入任何额外调用。启用后只做一次调用；任何失败都降级成「本次没有建议」并继续，
      //      唯一例外是人工取消必须原样向上抛。它不推进阶段、不决定 planned_files、不改写任何事实。 ----
      if (agentRoleEnabled(this.config, "coordinator")) {
        const planPrompt = buildCoordinatorPlanPrompt({
          bug: {
            id: bug.id, title: bug.title, module: admission.context.module,
            severity: bug.severity, priority_label: bug.priority_label,
          },
          context: { ...admission.context },
          repo: { name: repo.name, roots: workspaceRoots },
          ...(retryText ? { retryEvidence: retryText } : {}),
        });
        const plan = await this.runCoordinator({
          prompt: planPrompt,
          auditAttemptId,
          phase: "coordinator_plan",
          bugId: bug.id,
          repoDir: repo.path,
          timeoutS: roleCappedTimeout("coordinator", _COORDINATOR_PLAN_TIMEOUT_S),
          parse: parseCoordinatorPlan,
          degradeMessage: "coordinator 计划调用未产出可用建议（已忽略，调查按原流程继续）",
        });
        if (plan) {
          coordinatorPlanText = formatCoordinatorPlanForPrompt(plan);
          this.store.audit.event(auditAttemptId, "coordinator_plan", {
            role: "coordinator", model: this.modelForRole("coordinator"),
            timeout_s: roleCappedTimeout("coordinator", _COORDINATOR_PLAN_TIMEOUT_S),
            // 与 agent_input 同一口径：审计只落哈希与结构化摘要，不落建议正文（正文会进调查 prompt）。
            plan_hash: evidenceHash(coordinatorPlanText),
            focus_areas: plan.focus_areas.length, risks: plan.risks.length,
            verification_hints: plan.verification_hints.length,
            has_understanding: Boolean(plan.understanding),
          });
          this.store.addEvent(
            `coordinator 已给出调查计划建议（${plan.focus_areas.length} 个方向 / ${plan.risks.length} 个风险，仅作参考）`,
            "info",
            bug.id,
          );
        }
      }
      let investigationPrompt = buildInvestigationPrompt(
        bug, repo.name, repo.path, resourceMcpEnabled, workspaceRoots,
      ) + formatFeedbackMemories(selectFeedbackMemories(bug, feedbackMemories(this.store)))
        + (retryText ? `\n# 上次失败证据（调查时必须核对，避免换方向后丢失已有定位）\n${retryText}` : "")
        + (coordinatorPlanText ? `\n${coordinatorPlanText}` : "");
      this.store.audit.event(auditAttemptId, "investigation_input", {
        prompt_hash: evidenceHash(investigationPrompt), roots: workspaceRoots,
        context_key: contextKey, tools: investigationMcpServers,
        role: "investigation",
        model: agentRoleModel(this.config, "investigation") || effectivePiModel(this.config.pi),
      });
      const investigationRunOptions = {
        repoDir: repo.path,
        additionalDirs: investigationAdditionalDirs,
        role: "investigation" as const,
        timeoutS: roleStageTimeout("investigation", investigationTimeoutS),
        tools: ["read", "grep", "find", "ls"],
        maxCommandExecutions: _INVESTIGATION_COMMAND_BUDGET,
        repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
        completionGraceSeconds: 30,
        sandboxMode: "read-only" as const,
        mcpServers: investigationMcpServers,
        requiredMcpServers: resourceMcpServers,
        onProgress: (msg: string) => this.store.addEvent(msg, "debug", bug.id),
        onAudit: (event: Record<string, unknown>) => this.store.audit.event(auditAttemptId, "agent", { phase: "investigation", ...event }),
        cancelEvent: this.cancelEvent,
        media: investigationMedia,
      };
      const recoveryTimeoutS = derivedRecoveryTimeoutS(this.config.agent_timeout_s);
      /** 严格校验链（结构化解析 → 具体文件 → 文件必须存在）；主结果、收尾结果、补充结果统一走它。 */
      const strictInvestigation = (output: string): InvestigationResult =>
        validateInvestigationOutput(
          output,
          admission.context.diagnostic_links,
          { ...admission.context },
          workspaceRoots,
        );
      /** 无工具收尾轮：只整理已有轨迹、不做任何调查。
       *  每个检索轮最多一次（主调查 1 次 + 补充核查 1 次，整轮最多 2 次），无递归、无循环。 */
      let toolsFreeRecoveryRuns = 0;
      const runToolsFreeRecovery = async (evidence: string): Promise<AgentResult> => {
        if (toolsFreeRecoveryRuns >= _TOOLS_FREE_RECOVERY_LIMIT) {
          throw new AgentInvestigationLimitError(
            `无工具收尾次数已达上限(${_TOOLS_FREE_RECOVERY_LIMIT} 次)`,
            evidence.slice(-8000),
          );
        }
        toolsFreeRecoveryRuns += 1;
        return agent.run({
          ...investigationRunOptions,
          role: "recovery",
          prompt: buildInvestigationTimeoutRecoveryPrompt(investigationPrompt, evidence),
          timeoutS: roleCappedTimeout("recovery", recoveryTimeoutS),
          tools: [],
          thinkingLevel: "off",
          maxCommandExecutions: _RECOVERY_COMMAND_BUDGET,
          repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
          completionGraceSeconds: 30,
          mcpServers: [],
          requiredMcpServers: [],
          media: [],
        });
      };
      let investigated: AgentResult;
      phase = "investigation";
      this.applyStage("investigation");
      const previous = retryEntries.at(-1);
      if (previous?.context_key === contextKey && previous.phase === "investigation") {
        investigationProgress = previous.investigation_progress
          ?? (previous.partial_output ? captureInvestigationProgress(
            previous.partial_output, parseInvestigation(JSON.stringify(previous.investigation ?? {})),
          ) : undefined);
        if (investigationProgress) {
          // 上一轮的校验缺项（validation_errors）单独传给继续调查提示：它们是“输出缺了什么”，
          // 不是业务未决问题，所以既不进断点 open_questions，也不会被当成需要用户补充的信息。
          const previousValidationErrors = Array.isArray(previous.investigation?.validation_errors)
            ? (previous.investigation!.validation_errors as unknown[]).map((item) => String(item)).filter(Boolean)
            : [];
          investigationPrompt = buildInvestigationContinuationPrompt(
            investigationPrompt, investigationProgress, previousValidationErrors,
          );
          this.store.addEvent("恢复未完成调查断点：核对已读文件，仅补查未确认问题", "info", bug.id);
        }
      }
      const saved = previous?.context_key === contextKey && previous.phase === "implementation"
        && /超时|timeout|停滞/i.test(previous.failure_reason) && previous.investigation
        ? requireExistingPlannedFiles(requireConcretePlannedFiles(parseInvestigation(JSON.stringify(previous.investigation))), workspaceRoots)
        : undefined;
      try {
        if (saved?.ok) {
          investigated = resultFromOutput(JSON.stringify(saved), 0);
          this.store.addEvent("恢复上次调查检查点：由编码阶段核对当前源码后续修，不重新做全仓调查", "info", bug.id);
        } else {
          investigated = await agent.run({
            prompt: investigationPrompt,
            ...investigationRunOptions,
          });
        }
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error; // provider 故障：不是工作区问题
        if (error instanceof AgentInfrastructureError) {
          throw new WorkspaceBlockedError(error.message);
        }
        if (error instanceof AgentInvestigationLimitError || error instanceof AgentTimeoutError) {
          const limited = error instanceof AgentInvestigationLimitError;
          this.store.addEvent(
            limited
              ? "只读调查达到工具预算，正在根据已取得的代码证据强制收敛，不要求补充工单信息"
              : `只读调查达到 ${investigationTimeoutS}s，正在根据已取得的代码证据强制收敛，不要求补充工单信息`,
            "warn",
            bug.id,
          );
          // partialOutput 是 piRecoveryTrace 混合轨迹（工具回显 + 助手文本），
          // 只能当非授权 checkpoint 保存，绝不直接采纳为可执行的调查结论。
          const partialCheckpoint = strictInvestigation(error.partialOutput);
          investigationOutput = error.partialOutput;
          investigationCheckpoint = partialCheckpoint;
          investigationProgress = captureInvestigationProgress(error.partialOutput, partialCheckpoint, investigationProgress);
          this.store.updateJob(bug.id, { investigation: partialCheckpoint });
          try {
            // 收尾调用的是 recovery 角色（模型可能与调查角色不同）：只切换展示用的模型，
            // 阶段标签仍是「只读调查」，跑完立刻还原，异常路径由外层 finally 兜底。
            this.setStageModelForRole("recovery");
            investigated = await runToolsFreeRecovery(error.partialOutput);
          } catch (recoveryError) {
            if (recoveryError instanceof ProviderUnavailableError) throw recoveryError;
            if (recoveryError instanceof AgentInfrastructureError) {
              throw new WorkspaceBlockedError(recoveryError.message);
            }
            throw withRecoveryEvidence(error, recoveryError);
          } finally {
            this.restoreStageModel();
          }
          if (!investigated.ok) {
            throw new Error(
              `调查${limited ? "达到工具预算" : "超时"}后的收敛 Agent 异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`,
            );
          }
        } else {
          throw error;
        }
      }
      if (!investigated.ok) {
        throw new Error(`调查 Agent 异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`);
      }
      let investigation: InvestigationResult = strictInvestigation(
        investigated.raw_output || investigated.log || investigated.summary,
      );
      investigationOutput = investigated.raw_output || investigated.log || investigated.summary;
      investigationCheckpoint = investigation;
      investigationProgress = captureInvestigationProgress(investigationOutput, investigation, investigationProgress);
      this.store.updateJob(bug.id, { investigation });
      if (!investigation.ok && !investigation.blocked_reasons.length) {
        this.store.addEvent(
          `调查证据或结构化结果不完整，继续定向核查缺失项（最多 ${SUPPLEMENTARY_COMMAND_BUDGET} 次工具调用，不计入 Bug 重试）`,
          "warn",
          bug.id,
        );
        try {
          investigated = await agent.run({
            prompt: buildInvestigationRecoveryPrompt(
              investigationPrompt,
              investigationOutput,
              investigation.validation_errors,
              investigationProgress,
              SUPPLEMENTARY_COMMAND_BUDGET,
            ),
            ...investigationRunOptions,
            role: "investigation",
            timeoutS: roleCappedTimeout("investigation", recoveryTimeoutS),
            tools: ["read", "grep", "find", "ls"],
            maxCommandExecutions: SUPPLEMENTARY_COMMAND_BUDGET,
            repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
            completionGraceSeconds: 30,
            mcpServers: [],
            requiredMcpServers: [],
            media: [],
          });
        } catch (error) {
          if (error instanceof ProviderUnavailableError) throw error; // provider 故障：不是工作区问题
          if (error instanceof AgentInfrastructureError) throw new WorkspaceBlockedError(error.message);
          if (error instanceof AgentInvestigationLimitError || error instanceof AgentTimeoutError) {
            // 与主轮对齐：混合轨迹只当 checkpoint 保存，不足时最多一次无工具收尾；
            // 收尾返回的助手输出（仅 assistant 文本）再走严格校验。
            const supplementalCheckpoint = strictInvestigation(error.partialOutput);
            // 保留三段证据：主搜索轨迹（可能只剩在检查点里）、主输出、补查中断轨迹。
            const mergedEvidence = mergeInvestigationEvidence([
              { label: "主搜索轨迹（检查点保留，可能已被后续轨迹修正）", text: investigationProgress?.trace ?? "" },
              { label: "上一轮输出（可能已被后续轨迹否定，不得直接据此下结论）", text: investigationOutput },
              { label: "补充核查中断前轨迹（同一轮，最新）", text: error.partialOutput },
            ]);
            investigationOutput = mergedEvidence;
            investigationCheckpoint = supplementalCheckpoint;
            investigationProgress = captureInvestigationProgress(mergedEvidence, supplementalCheckpoint, investigationProgress);
            this.store.updateJob(bug.id, { investigation: supplementalCheckpoint });
            this.store.addEvent(
              `补充核查达到时限/工具预算（试行限额 ${SUPPLEMENTARY_COMMAND_BUDGET} 次），按已有证据做一次无工具收尾`,
              "warn",
              bug.id,
            );
            try {
              // 与主调查轮一致：收尾用 recovery 角色，模型同步切换（阶段标签仍是「只读调查」），
              // 无论成功失败都在 finally 还原。
              this.setStageModelForRole("recovery");
              investigated = await runToolsFreeRecovery(mergedEvidence);
            } catch (shutdownError) {
              if (shutdownError instanceof ProviderUnavailableError) throw shutdownError;
              if (shutdownError instanceof AgentInfrastructureError) {
                throw new WorkspaceBlockedError(shutdownError.message);
              }
              throw withRecoveryEvidence(new AgentInvestigationLimitError(
                "调查补充核查未完成",
                mergedEvidence,
              ), shutdownError);
            } finally {
              this.restoreStageModel();
            }
            if (!investigated.ok) {
              throw new Error(
                `调查补充核查后的收尾 Agent 异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`,
              );
            }
          } else {
            throw error;
          }
        }
        if (!investigated.ok) {
          throw new Error(
            `调查 Agent 补充轮异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`,
          );
        }
        investigation = strictInvestigation(
          investigated.raw_output || investigated.log || investigated.summary,
        );
      }
      investigationOutput = investigated.raw_output || investigated.log || investigated.summary;
      investigationCheckpoint = investigation;
      investigationProgress = captureInvestigationProgress(investigationOutput, investigation, investigationProgress);
      this.store.updateJob(bug.id, { investigation });
      if (!investigation.ok) {
        const reason = [...investigation.blocked_reasons, ...investigation.validation_errors].join("；");
        if (investigation.blocked_reasons.length) {
          // 两类人工出口都不消耗修复尝试次数：业务未决问题 / 现有代码疑似已包含修复、
          // 修复前基线不可确认。两者都不能被当成“输出格式不完整”去自动重试。
          const needsHuman = investigation.blocked_reasons.some((item) =>
            item.startsWith(BUSINESS_QUESTION_PREFIX) || item.startsWith(BASELINE_UNCONFIRMED_PREFIX));
          throw new InvestigationBlockedError(
            (needsHuman
              ? "只读调查无法在无人工确认的情况下继续（不消耗修复尝试次数）"
              : "只读 Agent 明确无法定位问题")
            + ": " + investigation.blocked_reasons.join("；"),
          );
        }
        throw new Error("调查结果格式不完整，将使用新上下文自动重试: " + (reason || "输出不可解析"));
      }
      this.store.addEvent(
        `调查完成：置信度 ${investigation.confidence}，计划修改 ${investigation.planned_files.length} 个文件`,
        "info",
        bug.id,
      );
      this.store.updateJob(bug.id, { investigation });
      investigationCheckpoint = investigation;
      // 调查阶段可以只读查看所有附加 Git 仓库；只有调查明确计划修改某个 Git 根时，
      // 才检查该仓库并创建修复分支。普通 P4/TypeScript Bug 不触碰任何 Git 分支。
      const amendment = scopeAmendment(investigationOutput);
      if (amendment) {
        const amendmentPrompt = `${investigationPrompt}\n# 只读范围补充复核（仅一轮）\n原调查: ${JSON.stringify(investigation)}\n范围申请（待核查数据）: ${JSON.stringify(amendment)}\n核对所列文件对复用或完整修复是否必要。保留原 repair_contract 与原 planned_files，仅可加入申请文件；不要再申请扩大。返回完整 FINAL_RESULT，scope_amendment=null。`;
        this.store.audit.event(auditAttemptId, "scope_amendment_requested", { ...amendment, prompt_hash: evidenceHash(amendmentPrompt) });
        const amended = await agent.run({ ...investigationRunOptions, prompt: amendmentPrompt, timeoutS: roleCappedTimeout("investigation", Math.min(this.config.agent_timeout_s, 180)) });
        if (!amended.ok) throw new VerificationError("范围补充调查执行失败");
        const output = amended.raw_output || amended.log || amended.summary;
        const revised = strictInvestigation(output);
        if (scopeAmendment(output)) throw new VerificationError("范围补充仅允许一轮");
        validateAmendedScope(investigation, revised, amendment.files, this.config.quality.max_changed_files);
        // 范围补充轮只负责加文件：原调查已登记的验证限制不能被这一轮悄悄丢掉。
        const carriedLimitations = [...new Set([
          ...(investigation.verification_limitations ?? []),
          ...(revised.verification_limitations ?? []),
        ])];
        const merged: InvestigationResult = { ...revised, verification_limitations: carriedLimitations };
        this.store.audit.event(auditAttemptId, "scope_amendment_approved", { previous_files: investigation.planned_files, revised: merged });
        investigation = merged;
        investigationCheckpoint = merged;
        this.store.updateJob(bug.id, { investigation });
      }
      gitAttempts = await this.prepareGitAttempts(
        repo,
        this.workspaceOf(bug),
        investigation.planned_files,
        bug.id,
      );
      for (const attempt of gitAttempts) {
        this.store.addEvent(
          `Git ${attempt.config.name} 已从 ${attempt.session.baseBranch} 创建分支 ${attempt.session.branch}`,
          "info",
          bug.id,
        );
      }
      const implementationAdditionalDirs = gitAttempts.map((attempt) => attempt.config.path);
      const p4Targets = p4ReconcileTargets(investigation.planned_files);
      if (p4Targets.length) {
        try {
          const syncEvidence = await p4.sync(p4Targets);
          this.store.audit.event(auditAttemptId, "p4_sync", { targets: p4Targets, output: syncEvidence, client: this.config.p4.client || null });
        } catch (error) {
          if (error instanceof P4SyncTimeoutError) {
            throw new WorkspaceBlockedError(
              `P4 精确同步超时，未进入修改阶段；请检查 P4 服务或工作区后人工重试: ${error.message}`,
            );
          }
          throw error;
        }
        const existingP4Targets = p4Targets.filter((target) => {
          const relative = target.replace(/^\.\//, "");
          return fs.existsSync(path.resolve(repo.path, ...relative.split("/")));
        });
        if (existingP4Targets.length) {
          this.recordWriteIntent(bug.id, p4, investigation.planned_files);
          await p4.edit(existingP4Targets);
          orchestratorOpenedTargets = existingP4Targets;
          this.store.addEvent(
            `P4: 编排器已在 default changelist 打开 ${existingP4Targets.length} 个已有计划文件`,
            "info",
            bug.id,
          );
        }
      } else {
        this.store.addEvent(
          "P4: planned_files 不包含 project 路径，本次无需同步 P4 文件",
          "debug",
          bug.id,
        );
      }
      behaviorChecks = await prepareBehaviorChecks(repo.behavior_checks, repo.path, investigation.planned_files, this.cancelEvent);
      if (this.cancelEvent.cancelled) throw new AgentCancelledError("行为测试已取消");
      this.store.audit.event(auditAttemptId, "behavior_baseline", {
        checks: behaviorChecks,
      });
      this.store.audit.event(auditAttemptId, "source_baseline", { files: sourceEvidence(investigation.planned_files, workspaceRoots) });
      const prompt = withPreopenedP4Files(buildImplementationPrompt({
        bug,
        repoName: repo.name,
        repoPath: repo.path,
        verifyCommands: this.verificationCommands(repo, investigation.planned_files),
        investigation,
        retryEvidence: retryText,
        reviewerFeedback: "",
        unrealMcpEnabled: resourceMcpEnabled,
        workspaceRoots,
      }));
      this.store.audit.event(auditAttemptId, "implementation_input", {
        prompt_hash: evidenceHash(prompt), investigation,
        verification_limitations: investigation.verification_limitations ?? [],
        git_bases: gitAttempts.map(a => ({ root: a.config.name, commit: a.session.baseCommit })),
        verification_commands: this.verificationCommands(repo, investigation.planned_files),
      });
      this.store.addEvent(
        retryText
          ? `调用编码 Agent（pi）（第 ${attempts} 次尝试，注入上次失败证据）`
          : `调用编码 Agent（pi）`,
        "info",
        bug.id,
      );
      const implementationMedia = await this.mediaInputsForBug(bug);
      phase = "implementation";
      this.applyStage("implementation");
      const searchPaths = defaultSearchPaths(repo.path, investigation.planned_files.flatMap((file) => {
        const separator = file.indexOf(":");
        const alias = separator < 0 ? "project" : file.slice(0, separator);
        const root = workspaceRoots.find((item) => item.alias === alias);
        return root ? [path.resolve(root.path, separator < 0 ? file : file.slice(separator + 1))] : [];
      }));
      const implementationRunOptions = {
        prompt,
        repoDir: repo.path,
        additionalDirs: implementationAdditionalDirs,
        role: "implementation" as const,
        timeoutS: roleStageTimeout("implementation", this.config.agent_timeout_s),
        maxCommandExecutions: _IMPLEMENTATION_COMMAND_BUDGET,
        repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
        maxReadOnlyExecutionsBeforeWrite: _IMPLEMENTATION_READ_ONLY_BEFORE_WRITE_LIMIT,
        maxSecondsBeforeWrite: Math.min(this.config.agent_timeout_s, 900),
        sandboxMode: "workspace-write",
        mcpServers: resourceMcpServers,
        requiredMcpServers: resourceMcpServers,
        onProgress: (msg: string) => this.store.addEvent(msg, "debug", bug.id),
        onFileWrite: (file?: string) =>
          this.recordWriteIntent(bug.id, p4!, investigation.planned_files, file),
        onAudit: (event: Record<string, unknown>) => this.store.audit.event(auditAttemptId, "agent", { phase: "implementation", ...event }),
        cancelEvent: this.cancelEvent,
        media: implementationMedia,
        searchPaths,
      } as const;
      let result: AgentResult;
      let workspaceChangesTakenOver = false;
      try {
        result = await agent.run(implementationRunOptions);
      } catch (error) {
        if (!(error instanceof AgentInvestigationLimitError || error instanceof AgentTimeoutError)) {
          throw error;
        }
        const hasChanges = await this.hasImplementationChanges(
          p4,
          gitAttempts,
          [...investigation.planned_files, ...this.lastAttemptFiles(bug.id)],
        );
        if (hasChanges) {
          result = resultFromOutput(error.partialOutput, 0);
          result.log = error.partialOutput;
          result.summary = result.summary
            || "编码 Agent 达到执行预算后，按工作区真实 diff 接管并继续验证";
          workspaceChangesTakenOver = true;
          this.store.addEvent(
            "编码 Agent 达到执行预算，但已产生真实改动；不判成功，转交验证门检查 diff 和测试",
            "warn",
            bug.id,
          );
        } else {
          this.store.addEvent(
            `编码阶段达到预算但没有真实改动，启动一次 ${_IMPLEMENTATION_RECOVERY_TIMEOUT_S}s 定向收尾`,
            "warn",
            bug.id,
          );
          try {
            // 上面的真实改动检查会关闭未改动的预打开文件；恢复编码前重新使其可写。
            if (orchestratorOpenedTargets.length) await p4.edit(orchestratorOpenedTargets);
            // 收尾子调用用 recovery 角色：模型同步切换（阶段标签仍是「实施编码」），
            // 无论成功失败都在 finally 还原。
            this.setStageModelForRole("recovery");
            result = await agent.run({
              ...implementationRunOptions,
              role: "recovery",
              prompt: buildImplementationRecoveryPrompt(prompt, error.partialOutput),
              timeoutS: roleCappedTimeout("recovery", Math.min(this.config.agent_timeout_s, _IMPLEMENTATION_RECOVERY_TIMEOUT_S)),
              maxCommandExecutions: _IMPLEMENTATION_RECOVERY_COMMAND_BUDGET,
              maxReadOnlyExecutionsBeforeWrite: _IMPLEMENTATION_RECOVERY_READ_ONLY_BEFORE_WRITE_LIMIT,
              maxSecondsBeforeWrite: Math.min(this.config.agent_timeout_s, 90),
              completionGraceSeconds: 30,
              media: [],
            });
          } catch (recoveryError) {
            if (!(recoveryError instanceof AgentInvestigationLimitError
                || recoveryError instanceof AgentTimeoutError)) throw recoveryError;
            const recoveryHasChanges = await this.hasImplementationChanges(
              p4,
              gitAttempts,
              [...investigation.planned_files, ...this.lastAttemptFiles(bug.id)],
            );
            if (!recoveryHasChanges) throw withRecoveryEvidence(error, recoveryError);
            result = resultFromOutput(recoveryError.partialOutput, 0);
            result.log = recoveryError.partialOutput;
            result.summary = result.summary
              || "定向收尾达到执行预算后，按工作区真实 diff 接管并继续验证";
            workspaceChangesTakenOver = true;
            this.store.addEvent(
              "定向收尾达到执行预算，但已产生真实改动；不判成功，转交验证门检查 diff 和测试",
              "warn",
              bug.id,
            );
          } finally {
            this.restoreStageModel();
          }
        }
      }
      lastResult = result;
      if (!result.ok) {
        throw new Error(`修复 Agent 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
      }
      investigation = this.absorbImplementationLimitations(bug.id, investigation, result);
      investigationCheckpoint = investigation;
      if (orchestratorOpenedTargets.length) {
        await p4.revertUnchanged(orchestratorOpenedTargets);
        orchestratorOpenedTargets = [];
      }
      if (result.blocked_reasons.length && !workspaceChangesTakenOver) {
        throw new VerificationError("修复 Agent 报告仍有阻塞项: " + result.blocked_reasons.join("；"));
      }
      const manualAssets = new Map(result.manual_assets.map((asset) => [asset.path, asset]));
      if (result.manual_assets.length) {
        this.store.addEvent(`识别到需人工处理资源 ${result.manual_assets.length} 项`, "info", bug.id);
      }

      // ---- 验证门 ----
      phase = "verification";
      this.applyStage("verification");
      let opened: OpenedFile[] | null = null;
      let testOut = "";
      let verificationPassed = false;
      let reviewPassed = false;
      if (!hasCodeChanges(result)) {
        // 回归：Agent 实际改了代码，但最终输出没按格式给出可解析的 FINAL_RESULT
        // （网关把原生工具调用协议泄进文本、代码块未闭合等）时，曾被直接判「未产出
        // 任何改动」而失败，已完成的修复被丢在 default changelist 里无人认领。
        // 这里按 P4/Git 事实采纳改动，保住已完成的工作。即使同时报告了人工资源，
        // 也不能把已经产生的代码改动误归类为 manual_only。
        opened = await checkAndPrepareP4(
          p4,
          p4ReconcileTargets(investigation.planned_files),
        ).catch(() => null);
        if (opened && opened.length) {
          result.changed_files = opened.map((o) => o.depot);
          result.summary =
            result.summary || "(Agent 最终输出未解析出结构化结果，改动清单按 p4 打开文件采纳)";
          this.store.addEvent(
            "Agent 输出缺少可解析的 FINAL_RESULT，已按 p4 打开文件采纳改动",
            "warn",
            bug.id,
          );
        }
        const gitFiles = (await Promise.all(gitAttempts.map(async (attempt) =>
          (await attempt.workspace.changedFiles(attempt.session.baseCommit)).map((file) =>
            `${attempt.config.name.toLowerCase()}:${file}`)))).flat();
        if (gitFiles.length) {
          result.changed_files = [...new Set([...result.changed_files, ...gitFiles])];
          result.summary = result.summary
            || "(Agent 最终输出未解析出结构化结果，改动清单按 Git 工作区事实采纳)";
          this.store.addEvent(
            "Agent 输出缺少可解析的 FINAL_RESULT，已按 Git 工作区改动采纳",
            "warn",
            bug.id,
          );
        }
      }
      if (hasCodeChanges(result)) {
        let verified;
        try {
          verified = await this.verifyCandidate(
            p4, repo, gitAttempts, opened, investigation.planned_files,
            [...result.changed_files, ...this.lastAttemptFiles(bug.id)],
            auditAttemptId,
            behaviorChecks,
          );
        } catch (error) {
          if (workspaceChangesTakenOver) {
            throw new VerificationError(
              `编码 Agent 达到执行预算，已产生的候选改动验证失败: ${String(error)}`,
            );
          }
          throw error;
        }
        opened = verified.opened;
        result.changed_files = [
          ...opened.map((item) => `project:${item.depot}`),
          ...verified.gitFiles,
        ];
        testOut = verified.summary;
        verificationPassed = verified.verified;
        this.store.updateJob(bug.id, { verification: verified });
        if (workspaceChangesTakenOver && !(this.config.review.enabled && verificationPassed)) {
          throw new VerificationError(
            "编码 Agent 达到执行预算；已有真实 diff 已完成验证，但流程未正常收尾，转人工评审而不冒充自动修复成功",
          );
        }
        if (this.config.review.enabled && verificationPassed) {
          phase = "review";
          this.applyStage("review");
          let review = await this.reviewCandidate(
            reviewer!,
            resolvedReviewerModel,
            p4,
            bug,
            investigation,
            verified.diff,
            verified.summary,
            implementationAdditionalDirs,
            await this.mediaInputsForBug(bug),
            resourceMcpServers,
          );
          this.store.updateJob(bug.id, { review_findings: review });
          let fixRound = 0;
          while (!review.approved && fixRound < this.config.review.max_fix_rounds) {
            fixRound += 1;
            // correction 之前：Reviewer 明确要求修改计划范围外的文件时，先把可安全批准的文件
            // 加入本次有效范围，修正 Agent 才不会「照做即越界、如实报告即失败」。
            // 无法安全批准的要求在这里直接转人工阻塞（不消耗重试）。
            const scopeBeforeCorrection = this.applyReviewScopeAmendment(
              bug, investigation, review, repo, auditAttemptId, "correction",
            );
            investigation = scopeBeforeCorrection.investigation;
            investigationCheckpoint = investigation;
            if (scopeBeforeCorrection.added.length) {
              // 扩围后重取行为基线：验证门、行为测试与后续评审都必须基于扩充后的有效范围。
              behaviorChecks = await prepareBehaviorChecks(
                repo.behavior_checks, repo.path, investigation.planned_files, this.cancelEvent,
              );
              if (this.cancelEvent.cancelled) throw new AgentCancelledError("行为测试已取消");
              this.store.audit.event(auditAttemptId, "behavior_baseline", { checks: behaviorChecks, scope_amendment: true });
              this.store.audit.event(auditAttemptId, "source_baseline", {
                files: sourceEvidence(investigation.planned_files, workspaceRoots), scope_amendment: true,
              });
            }
            const feedback = formatReviewerFeedback(review);
            this.store.addEvent(`Reviewer 拒绝候选，开始第 ${fixRound} 轮定向修正`, "warn", bug.id);
            this.applyStage("correction"); // 定向修正阶段用恢复角色模型（见 stageAgentRole）
            const correctionPrompt = withPreopenedP4Files(buildImplementationPrompt({
              bug,
              repoName: repo.name,
              repoPath: repo.path,
              verifyCommands: this.verificationCommands(repo, investigation.planned_files),
              investigation,
              retryEvidence: retryText,
              reviewerFeedback: feedback,
              unrealMcpEnabled: resourceMcpEnabled,
              workspaceRoots,
              scopeAmendment: scopeBeforeCorrection.added.length
                ? { files: scopeBeforeCorrection.added, reason: "Reviewer 阻断项明确指向这些计划外文件" }
                : undefined,
            }));
            const correctionOptions = {
              prompt: correctionPrompt,
              repoDir: repo.path,
              additionalDirs: implementationAdditionalDirs,
              // Reviewer 拒绝后的定向修正属于恢复/修正角色；审计 phase 仍是 correction（保持不变）。
              role: "recovery" as const,
              timeoutS: roleStageTimeout("recovery", this.config.agent_timeout_s),
              maxCommandExecutions: _IMPLEMENTATION_COMMAND_BUDGET,
              repeatedCommandLimit: _REPEATED_COMMAND_LIMIT,
              maxReadOnlyExecutionsBeforeWrite: _IMPLEMENTATION_READ_ONLY_BEFORE_WRITE_LIMIT,
              maxSecondsBeforeWrite: Math.min(this.config.agent_timeout_s, 900),
              sandboxMode: "workspace-write",
              mcpServers: resourceMcpServers,
              requiredMcpServers: resourceMcpServers,
              onProgress: (msg: string) => this.store.addEvent(msg, "debug", bug.id),
              onAudit: (event: Record<string, unknown>) => this.store.audit.event(auditAttemptId, "agent", { phase: "correction", ...event }),
              onFileWrite: (file?: string) =>
                this.recordWriteIntent(bug.id, p4!, investigation.planned_files, file),
              cancelEvent: this.cancelEvent,
              media: await this.mediaInputsForBug(bug),
            } as const;
            try {
              result = await agent.run(correctionOptions);
            } catch (error) {
              if (!(error instanceof AgentInvestigationLimitError) || error.wroteFile) throw error;
              this.store.addEvent(
                `Reviewer 修正阶段未落笔，启动一次 ${_IMPLEMENTATION_RECOVERY_TIMEOUT_S}s 定向收尾`,
                "warn",
                bug.id,
              );
              result = await agent.run({
                ...correctionOptions,
                role: "recovery",
                prompt: buildImplementationRecoveryPrompt(correctionPrompt, error.partialOutput),
                timeoutS: roleCappedTimeout("recovery", Math.min(this.config.agent_timeout_s, _IMPLEMENTATION_RECOVERY_TIMEOUT_S)),
                maxCommandExecutions: _IMPLEMENTATION_RECOVERY_COMMAND_BUDGET,
                maxReadOnlyExecutionsBeforeWrite: _IMPLEMENTATION_RECOVERY_READ_ONLY_BEFORE_WRITE_LIMIT,
                maxSecondsBeforeWrite: Math.min(this.config.agent_timeout_s, 90),
                completionGraceSeconds: 30,
                media: [],
              });
            }
            if (!result.ok) {
              throw new Error(`修正 Agent 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
            }
            investigation = this.absorbImplementationLimitations(bug.id, investigation, result);
            investigationCheckpoint = investigation;
            if (result.blocked_reasons.length) {
              throw new VerificationError("修正 Agent 报告仍有阻塞项: " + result.blocked_reasons.join("；"));
            }
            for (const asset of result.manual_assets) manualAssets.set(asset.path, asset);
            result.manual_assets = [...manualAssets.values()];
            lastResult = result;
            if (!hasCodeChanges(result)) {
              throw new VerificationError("Reviewer 修正阶段未产出代码改动: "
                + (result.blocked_reasons.join("；") || result.summary || "无输出"));
            }
            this.applyStage("verification"); // 修正后重新过验证门/评审
            // correction 结果之后：只对「评审明确指名」的计划外写入补一次受控扩围；
            // 没有评审指向的多余改动仍由 verifyCandidate 的范围门拒绝。
            const scopeAfterCorrection = this.applyReviewScopeAmendment(
              bug,
              investigation,
              review,
              repo,
              auditAttemptId,
              "verification",
              [...result.changed_files, ...this.lastAttemptFiles(bug.id)],
            );
            investigation = scopeAfterCorrection.investigation;
            investigationCheckpoint = investigation;
            verified = await this.verifyCandidate(
              p4, repo, gitAttempts, null, investigation.planned_files,
              [...result.changed_files, ...this.lastAttemptFiles(bug.id)],
              auditAttemptId,
              behaviorChecks,
            );
            opened = verified.opened;
            result.changed_files = [
              ...opened.map((item) => `project:${item.depot}`),
              ...verified.gitFiles,
            ];
            testOut = verified.summary;
            verificationPassed = verified.verified;
            this.store.updateJob(bug.id, { verification: verified });
            this.applyStage("review");
            review = await this.reviewCandidate(
              reviewer!,
              resolvedReviewerModel,
              p4,
              bug,
              investigation,
              verified.diff,
              verified.summary,
              implementationAdditionalDirs,
              await this.mediaInputsForBug(bug),
              resourceMcpServers,
            );
            this.store.updateJob(bug.id, { review_findings: review });
          }
          if (!review.approved) {
            throw new VerificationError("独立代码评审未通过: " + formatReviewerFeedback(review));
          }
          reviewPassed = true;
          this.store.addEvent("独立代码评审通过", "info", bug.id);
        }
      }
      if (!hasCodeChanges(result) && !hasManualAssets(result)) {
        const reason = result.blocked_reasons.join("; ") || result.log.slice(0, 300) || "无输出";
        throw new Error("Agent 未产出任何代码改动或资源说明: " + reason);
      }

      // ---- coordinator 汇总（只读、无工具）：在最终交付之前，把**已确定的事实**组织成
      //      一段附加说明。事实由编排器整理后原样给出（测试/文件/review 结论），
      //      coordinator 只能组织文字，不能改写它们；其产出只以附加段落形式进入交付描述，
      //      result.summary 与所有结构化事实保持不变。与计划调用同源，未显式配置该角色时不启用；
      //      启用后失败降级，只有取消向上抛。 ----
      if (agentRoleEnabled(this.config, "coordinator")) {
        const filesByRoot = (values: string[]): Record<string, string[]> => {
          const grouped: Record<string, string[]> = {};
          for (const value of values) {
            const separator = value.indexOf(":");
            const alias = separator > 0 ? value.slice(0, separator) : "project";
            const file = separator > 0 ? value.slice(separator + 1) : value;
            (grouped[alias] ??= []).push(file);
          }
          return grouped;
        };
        const review = loads<Record<string, unknown> | null>(
          this.store.getJob(bug.id)?.review_findings as string, null,
        );
        const summaryPrompt = buildCoordinatorSummaryPrompt({
          bug: { id: bug.id, title: bug.title },
          facts: {
            agent_result: { summary: result.summary, blocked_reasons: result.blocked_reasons },
            code_changes: {
              changed_files: result.changed_files,
              by_root: filesByRoot(result.changed_files),
              p4_opened_files: filesByRoot((opened ?? []).map((item) => `project:${item.depot}`)),
            },
            machine_verification: {
              configured: this.config.quality.require_verification || Boolean(repo.verify_cmds.length),
              passed: verificationPassed,
              output: truncate(testOut, 2000),
              limitations: investigation.verification_limitations ?? [],
            },
            review: this.config.review.enabled
              ? (review ? { ...review } : { unavailable: "评审未产出结论" })
              : { disabled: "本次未启用独立评审" },
            manual_assets: result.manual_assets.map((asset) => ({
              path: asset.path, reason: asset.reason ?? "",
            })),
          },
        });
        coordinatorSummary = await this.runCoordinator({
          prompt: summaryPrompt,
          auditAttemptId,
          phase: "coordinator_summary",
          bugId: bug.id,
          repoDir: repo.path,
          timeoutS: roleCappedTimeout("coordinator", _COORDINATOR_SUMMARY_TIMEOUT_S),
          parse: parseCoordinatorSummary,
          degradeMessage: "coordinator 汇总调用未产出可用文案（已忽略，交付事实不变）",
        });
        if (coordinatorSummary) {
          // 只追加文字：不改写 result.summary，也不影响任何结构化字段与交付分类。
          result.summary = [result.summary, formatCoordinatorSummaryForDelivery(coordinatorSummary)]
            .filter(Boolean).join("\n\n");
          this.store.audit.event(auditAttemptId, "coordinator_summary", {
            role: "coordinator", model: this.modelForRole("coordinator"),
            timeout_s: roleCappedTimeout("coordinator", _COORDINATOR_SUMMARY_TIMEOUT_S),
            // 同样只落哈希与计数：正文已作为附加段落追加进交付描述。
            summary_hash: evidenceHash(coordinatorSummary.summary),
            key_points: coordinatorSummary.key_points.length,
          });
          this.store.addEvent("coordinator 已补充交付说明（仅附加文字，不覆盖测试/文件/评审事实）", "info", bug.id);
        }
      }

      // ---- 分类 ----
      const state = hasCodeChanges(result)
        ? hasManualAssets(result)
          ? "candidate_partial"
          : reviewPassed
            ? "review_pending"
            : verificationPassed ? "verified" : "candidate"
        : "manual_only";

      // ---- 生成 pending changelist ----
      // opened 来自 checkAndPrepareP4（只含 default changelist 文件）；pending 的 Files
      // 列表只允许 default 里的文件，编号 changelist 的文件混进来 p4 change -i 必报
      // "Can't include file(s) not already opened"
      const files = [...new Set((opened ?? []).map((o) => o.depot))];
      const gitResults: Array<{ name: string; result: GitFinalizeResult }> = [];
      for (const attempt of gitAttempts) {
        const finalized = await attempt.workspace.finalize(
          attempt.session,
          `【b${bug.id}】${bug.title.trim() || `修复 Bug ${bug.id}`}`,
        );
        attempt.settled = true;
        if (finalized) {
          attempt.finalized = finalized;
          gitResults.push({ name: attempt.config.name, result: finalized });
          this.store.addEvent(
            `Git ${attempt.config.name} 已本地提交 ${finalized.commit.slice(0, 12)}（${finalized.branch}）`,
            "info",
            bug.id,
          );
        }
      }
      const desc = buildDescription(bug, result, testOut, [
        "本 changelist 由 TapdBugFixAgent 自动生成，请人工 review 后提交",
        ...gitResults.map(({ name, result: gitResult }) =>
          `Git ${name}: ${gitResult.branch} @ ${gitResult.commit}（仅本地提交，未 push）`),
        // 验证限制必须进入交付描述：不能静默丢失，也不能被当成已验证事实。
        ...(investigation.verification_limitations ?? []).map((item) =>
          `验证限制（未执行/无法执行，不得视为已通过）: ${item}`),
      ]);
      let cl: number | null = null;
      if (files.length && ["candidate", "candidate_partial", "verified", "review_pending"].includes(state)) {
        // 只把 default changelist 里本次收集到的文件放进新 changelist
        cl = await p4.createPending(desc, files);
        this.store.addEvent(`已创建 pending changelist ${cl}`, "info", bug.id);
      }

      this.store.updateJob(bug.id, {
        agent_state: state,
        changelist: cl,
        generated_description: desc,
        files: dumps([
          ...files.map((file) => `project:${file}`),
          ...gitResults.flatMap(({ name, result: gitResult }) =>
            gitResult.files.map((file) => `${name.toLowerCase()}:${file}`)),
        ]),
        manual_assets: dumps(result.manual_assets),
        agent: "pi",
        failure_reason: null,
        retry_evidence: null, // 成功则清空重试证据
        last_attempt_files: null,
        finished_at: nowStr(),
      });
      const delivered = this.store.getJob(bug.id)!;
      const verification = loads<Record<string, unknown>>(delivered.verification as string, {});
      if (hasCodeChanges(result)) this.store.audit.candidate(auditAttemptId, {
        diff: String(verification.diff || ""), files: result.changed_files,
        delivery: state === "candidate_partial" ? "partial" : "complete",
        evidence: { verification, review: loads(delivered.review_findings as string, {}),
          investigation, changelist: cl, git_results: gitResults, manual_assets: result.manual_assets,
          verification_limitations: investigation.verification_limitations ?? [] },
      });

      // 走到这里说明本轮的模型调用确实成功返回过：provider 健康，退避计数归零。
      // 放在 Tapd 回写之前，避免回写失败/被取消时把「provider 已恢复」的事实丢掉。
      this.resetProviderBackoffAfterSuccess();

      // ---- Tapd 回写 ----
      await this.notifyTapd(bug, state, cl, result, gitResults, investigation.verification_limitations ?? []);
      this.store.addEvent(
        `完成（${state}）`
          + (cl ? `，changelist ${cl}` : "")
          + (gitResults.length ? `，Git 分支 ${gitResults.map((item) => item.result.branch).join(", ")}` : ""),
        "info",
        bug.id,
      );
    } catch (exc) {
      if (p4 && activeRepo && ["implementation", "verification", "review"].includes(phase)
        && !this.store.audit.attempts(bug.id).find(a=>a.attempt_id===auditAttemptId)?.events.some(e=>e.kind==="patch")) {
        try {
          const capture = p4.forkForCleanup();
          const files = await capture.opened("default", true);
          const diffs = files.length ? [await capture.candidateDiff(files)] : [];
          const names = files.map(f=>`project:${f.depot}`);
          for (const git of gitAttempts) {
            diffs.push(await git.workspace.diff(git.session.baseCommit));
            names.push(...(await git.workspace.changedFiles(git.session.baseCommit)).map(f=>`${git.config.name}:${f}`));
          }
          if (hasPatchEvidence(diffs.join("\n"))) this.store.audit.event(auditAttemptId,"patch",{diff:diffs.join("\n"),files:names});
        } catch (captureError) { this.store.audit.event(auditAttemptId,"patch_capture_failed",{reason:String(captureError)}); }
      }
      let p4CleanupError: unknown = null;
      if (p4 && orchestratorOpenedTargets.length) {
        try {
          await p4.forkForCleanup().revertUnchanged(orchestratorOpenedTargets);
        } catch (cleanupError) {
          p4CleanupError = cleanupError;
          this.store.addEvent(`P4: 清理编排器预打开的未修改文件失败: ${String(cleanupError)}`, "warn", bug.id);
        }
      }
      // 失败或人工中断可能留下未登记文件；下一次重新做一次完整基线扫描。
      if (activeRepo && activeRepo.preflight_reconcile === "once") {
        this.cleanP4Baselines.delete(activeRepo.path.replace(/\\/g, "/").toLowerCase());
      }
      let failure = exc;
      // provider 健康状态的判定依据是「原始异常」，必须在这里就从 exc 上取。
      // 后面 cleanup 失败会把 failure 替换成 WorkspaceBlockedError（工作区优先级更高），
      // 那时再取 failure 就永远是 null，冷却不会开启，下一单继续撞同一个不可用的 provider。
      const providerOutage = exc instanceof ProviderUnavailableError ? exc : null;
      if (failure instanceof P4ConnectionError) {
        failure = new WorkspaceBlockedError(
          `P4 服务当前不可用，可能处于休眠恢复、VPN/网络重连或服务维护期间；` +
          `本次不消耗 Bug 修复重试，请恢复连接后人工重试: ${failure.message}`,
        );
      }
      if (gitAttempts.length) {
        try {
          await this.rollbackGitAttempts(gitAttempts);
          this.store.addEvent("已清理本次尝试创建的 Git 分支", "warn", bug.id);
        } catch (cleanupError) {
          failure = new WorkspaceBlockedError(`${String(exc)}；${String(cleanupError)}`);
        }
      }
      // 真实 cleanup 失败必须高于 provider 状态：清理没做完说明工作区可能仍留着本次
      // 尝试的打开文件，此时把任务标成可自动重试的 provider_unavailable 会让下一次尝试
      // 在脏工作区上继续。改为工作区阻塞（且原因含 P4/清理证据，历史恢复判定也会排除它）。
      if (providerOutage && p4CleanupError) {
        failure = new WorkspaceBlockedError(
          `${String(exc)}；清理未完成（P4 撤销预打开文件失败）: ${String(p4CleanupError)}`,
        );
      }
      // provider 的「健康状态」与本次任务的「失败分类」分开处理：无论任务最终落成
      // provider_unavailable，还是被 cleanup/P4 证据升级成工作区阻塞，都必须开全局冷却，
      // 否则下一单仍会撞上同一个已经不可用的 provider（现场曾因此 5 分钟内连败 17 单）。
      // 但人工在本次尝试期间已经明确解除过冷却（generation 变化）时不再重开。
      if (providerOutage && this.store.providerCooldownEpoch() === cooldownEpochAtStart) {
        this.openProviderCooldown(providerOutage, bug.id);
      } else if (providerOutage) {
        this.store.addEvent(
          "人工已在本次尝试期间解除 provider 冷却，迟到的 provider 错误不再重开冷却",
          "info",
          bug.id,
        );
      }
      // job 分类看 failure（不是 providerOutage）：升级成工作区阻塞时 workspace 优先级更高。
      if (failure instanceof ProviderUnavailableError) {
        // 记录本次尝试遗留的 default 打开文件，供下一次尝试精确撤销。
        // 严格清点：查不到就必须知道（否则无法证明工作区可安全重试）。
        let leftoverRecorded = true;
        try {
          await this.recordAttemptEnd(bug.id, p4, true);
        } catch (recordError) {
          leftoverRecorded = false;
          this.store.addEvent(`provider 故障后登记遗留打开文件失败: ${String(recordError)}`, "warn", bug.id);
        }
        // 回读状态再写：人工重试/跳过可能已经改过状态，迟到的 provider 错误绝不能覆盖
        // 人工决定（与取消分支的保护一致）。
        const current = String(this.store.getJob(bug.id)?.agent_state ?? "");
        const humanOwnsState = current !== "" && current !== "in_progress";
        if (leftoverRecorded && !humanOwnsState) {
          this.store.updateJob(bug.id, {
            agent_state: "provider_unavailable",
            failure_reason: failure.message.slice(0, 1000),
            finished_at: nowStr(),
          });
        } else if (!leftoverRecorded && !humanOwnsState) {
          // 清点失败时无法证明工作区干净：不默认可安全重试，转工作区阻塞交人工确认。
          // 刻意不动 cleanP4Baselines：这里只负责不把脏工作区当成可安全重试，基线扫描
          // 的既有条件逻辑保持不变，避免影响必需的 preflight 扫描。
          this.store.updateJob(bug.id, {
            agent_state: "blocked_workspace",
            failure_reason:
              `provider 故障后无法清点遗留文件，工作区状态未确认（P4 清点失败）: `
              + failure.message.slice(0, 900),
            finished_at: nowStr(),
          });
          this.store.addEvent(
            "provider 故障且遗留文件未确认，已转工作区阻塞（不做默认可安全重试）",
            "warn",
            bug.id,
          );
        } else {
          this.store.addEvent(
            `provider 故障期间状态已被人工设置（${current}），保留人工设置不覆盖`,
            "warn",
            bug.id,
          );
        }
      } else if (failure instanceof WorkspaceBlockedError) {
        const reason = failure.message.slice(0, 1000);
        this.store.updateJob(bug.id, {
          agent_state: "blocked_workspace",
          failure_reason: reason,
          finished_at: nowStr(),
        });
        this.store.addEvent(`工作区阻塞: ${reason}`, "warn", bug.id);
      } else if (failure instanceof InvestigationBlockedError) {
        const reason = failure.message.slice(0, 1000);
        this.store.updateJob(bug.id, {
          agent_state: "needs_info",
          failure_reason: reason,
          finished_at: nowStr(),
        });
        this.store.addEvent(
          `只读调查已转人工处理（未消耗修复尝试次数）: ${reason}`,
          "warn",
          bug.id,
        );
      } else if (failure instanceof AgentCancelledError || failure instanceof P4CancelledError) {
        // 人工暂停/关闭/重试/跳过中断了本次尝试。只有状态仍是 in_progress（全局暂停/
        // 关闭）才回退 pending；人工重试/跳过已先把状态改成 pending/skipped，尊重人工
        // 设置，绝不能覆盖（回归：跳过正在跑的 bug 后，跑完的写回曾把 skipped 盖掉）。
        await this.recordAttemptEnd(bug.id, p4);
        const st = String(this.store.getJob(bug.id)?.agent_state ?? "");
        if (st === "in_progress" || st === "") {
          this.store.updateJob(bug.id, { agent_state: "pending", failure_reason: null, finished_at: null });
          this.store.addEvent("处理被人工中断（暂停/关闭），bug 回到待处理队列", "warn", bug.id);
        } else {
          this.store.addEvent(`处理被人工中断，保留人工设置的状态（${st}）`, "warn", bug.id);
        }
      } else {
        // lastResult 有值 = 本轮实现阶段的模型调用确实成功返回过 → provider 健康，退避归零。
        // 但 TAPD/P4 预检可能在任何模型调用之前就失败（此时 lastResult 为空），那种失败
        // 不构成「provider 可用」的证据，不能清零。
        if (lastResult) this.resetProviderBackoffAfterSuccess();
        await this.handleFailure(bug, failure, p4, lastResult, {
          phase, context_key: contextKey,
          investigation: investigationCheckpoint as unknown as Record<string, unknown> | undefined,
          investigation_progress: phase === "investigation" ? captureInvestigationProgress(
            failure instanceof AgentTimeoutError || failure instanceof AgentInvestigationLimitError
              ? failure.partialOutput : investigationOutput,
            investigationCheckpoint ?? parseInvestigation(""), investigationProgress,
          ) : undefined,
        });
      }
    } finally {
      // 阶段展示生命周期在 processBug 自身收口：无论从哪个入口调用（runLoop 或直接调用），
      // 结束后都回到「—」；currentBugId 仍由 processNext 负责（单测会直接调 processBug）。
      this.clearStage();
      const job = this.store.getJob(bug.id) || {};
      const snapshot = this.store.audit.attempts(bug.id).find(a => a.attempt_id === auditAttemptId)!;
      const verification = loads<Record<string, unknown>>(job.verification as string, {});
      const patch = snapshot.events.filter(e => e.kind === "patch").at(-1)?.payload;
      // Preserve failed candidates without passing them off as completed deliveries.
      if (!this.store.audit.candidates(bug.id).some(c => c.attempt_id === auditAttemptId) && patch) {
        try {
          this.store.audit.candidate(auditAttemptId, {
            diff: String(patch.diff || ""), files: patch.files as string[], delivery: "partial",
            evidence: { verification, review: loads(job.review_findings as string, {}),
              investigation: investigationCheckpoint, failure: job.failure_reason, phase },
          });
        } catch (error) {
          this.store.audit.event(auditAttemptId, "candidate_unavailable", { reason: String(error) });
        }
      }
      this.store.audit.event(auditAttemptId, "finished", {
        state: job.agent_state, phase, failure: job.failure_reason,
        investigation: investigationCheckpoint, verification,
        verification_limitations: investigationCheckpoint?.verification_limitations ?? [],
        review: loads(job.review_findings as string, {}),
      });
    }
  }

  /** 实施/修正 Agent 把纯验证限制（无法运行游戏、无自动化环境…）写进 blocked_reasons 时，
   *  迁移到 investigation.verification_limitations 并保留原文，不作为阻塞项。
   *  否则一条如实说明的限制会让每次尝试都判失败，形成必然失败的重试循环。 */
  private absorbImplementationLimitations(
    bugId: string,
    investigation: InvestigationResult,
    result: AgentResult,
  ): InvestigationResult {
    const limitations = result.blocked_reasons.filter(isVerificationLimitation);
    if (!limitations.length) return investigation;
    result.blocked_reasons = result.blocked_reasons.filter((item) => !isVerificationLimitation(item));
    const merged: InvestigationResult = {
      ...investigation,
      verification_limitations: [...new Set([...(investigation.verification_limitations ?? []), ...limitations])],
    };
    this.store.updateJob(bugId, { investigation: merged });
    this.store.addEvent(
      `实施 Agent 报告的验证限制已登记（不作为阻塞项，会进入交付说明）: ${limitations.join("；")}`,
      "warn",
      bugId,
    );
    return merged;
  }

  /** Tapd 回写：只发评论，绝不自动修改单子状态——状态由人工 review 并 submit 后自行处理。 */
  private async notifyTapd(
    bug: Bug,
    state: string,
    cl: number | null,
    result: AgentResult,
    gitResults: Array<{ name: string; result: GitFinalizeResult }> = [],
    verificationLimitations: string[] = [],
  ): Promise<void> {
    const ws = this.workspaceOf(bug);
    const client = this.tapd(ws);
    const lines = ["[TapdBugFixAgent] 自动修复完成，待人工 review。"];
    if (state === "candidate") lines.push("结果: 已生成候选补丁，但未配置机器验证命令，必须人工验证");
    else if (state === "candidate_partial") lines.push("结果: 已生成候选代码，且仍有资源项需人工处理");
    else if (state === "verified") lines.push("结果: 机器验证通过，等待人工代码评审");
    else if (state === "review_pending") lines.push("结果: 机器验证和独立评审通过，等待人工最终确认");
    else if (state === "manual_only") lines.push("结果: 该单为资源类修改，需人工处理（无代码改动）");
    if (cl) lines.push(`Perforce pending changelist: ${cl}（请 review 后人工 submit）`);
    for (const { name, result: gitResult } of gitResults) {
      lines.push(
        `Git ${name}: 分支 ${gitResult.branch}，commit ${gitResult.commit}（仅本地提交，请 review 后人工 push）`,
      );
    }
    lines.push("Tapd 状态未修改：请 review 代码并提交后自行更新单子状态。");
    if (verificationLimitations.length) {
      lines.push("验证限制（未执行/无法执行，不得视为已通过）:");
      for (const item of verificationLimitations) lines.push(`- ${item}`);
    }
    if (result.manual_assets.length) {
      lines.push("需人工处理的资源:");
      for (const a of result.manual_assets) {
        lines.push(`- ${a.path}` + (a.reason ? `  原因: ${a.reason}` : ""));
      }
    }
    lines.push("修复说明: " + (result.summary || "(无)"));
    try {
      await client.addComment(bug.id, lines.join("\n"));
      this.store.addEvent("已回写 Tapd 评论（单子状态不自动修改）", "info", bug.id);
    } catch (exc) {
      this.store.addEvent(`回写 Tapd 失败: ${exc}`, "error", bug.id);
    }
  }

  // ------------------------------------------------------------------
  // 重试证据（自动重试循环）
  // ------------------------------------------------------------------
  /** 读取 job 上累积的失败证据（每次失败压缩一条，供重试注入 prompt / 管理台查看）。 */
  private retryEvidenceEntries(bugId: string): RetryEvidenceEntry[] {
    const job = this.store.getJob(bugId) ?? {};
    return loads<RetryEvidenceEntry[]>(job.retry_evidence as string, []);
  }

  /** 上次尝试遗留的 default 打开文件（失败/取消都记，重试/恢复时清理）。 */
  private lastAttemptFiles(bugId: string): string[] {
    const job = this.store.getJob(bugId) ?? {};
    return loads<string[]>(job.last_attempt_files as string, []);
  }

  /** 写入一开始就持久化目标路径；进程若被强杀，finally 没机会执行时仍可追溯归属。 */
  private recordWriteIntent(bugId: string, p4: P4Client, plannedFiles: string[], file?: string): void {
    const normalizedRoot = p4.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    const normalize = (value: string): string => {
      let out = value.trim().replace(/\\/g, "/");
      if (out.toLowerCase().startsWith(normalizedRoot + "/")) out = out.slice(normalizedRoot.length + 1);
      if (out.toLowerCase().startsWith("project:")) out = out.slice("project:".length);
      return out.replace(/^\.\//, "").replace(/^\/+/, "");
    };
    const candidates = [
      ...p4ReconcileTargets(plannedFiles).map(normalize),
      ...(file ? [normalize(file)] : []),
    ].filter(Boolean);
    const files = [...new Set([...this.lastAttemptFiles(bugId), ...candidates])];
    this.store.updateJob(bugId, { last_attempt_files: dumps(files) });
  }

  private trackedPathMatchesDepot(tracked: string, depot: string, p4: P4Client): boolean {
    const root = p4.path.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
    let value = tracked.trim().replace(/\\/g, "/").toLowerCase();
    const normalizedDepot = depot.trim().replace(/\\/g, "/").toLowerCase();
    if (value.startsWith("project:")) value = value.slice("project:".length);
    if (value.startsWith(root + "/")) value = value.slice(root.length + 1);
    value = value.replace(/^\.\//, "").replace(/^\/+/, "");
    return normalizedDepot === tracked.trim().replace(/\\/g, "/").toLowerCase()
      || normalizedDepot.endsWith(`/${value}`);
  }

  /** 撤销上一次尝试遗留的打开文件，返回撤销列表；成功则清空记录。
   *  只碰「仍开在 default changelist」的文件：遗留文件可能已被并入某个编号
   *  pending changelist（其它 bug 的产物），p4 revert 连编号 changelist 里的改动
   *  也会一并丢弃，必须先对照当前 opened 状态确认，绝不盲撤。 */
  private async cleanupStaleAttempt(bugId: string, p4: P4Client): Promise<string[]> {
    const files = this.lastAttemptFiles(bugId);
    if (!files.length) return [];
    let inDefault = new Set<string>();
    try {
      inDefault = new Set((await p4.opened("default")).map((o) => o.depot));
    } catch {
      // 查询失败则空集 → 不撤（宁可不清理也不误杀编号 changelist 的改动）
    }
    const toRevert = [...inDefault].filter((depot) =>
      files.some((tracked) => this.trackedPathMatchesDepot(tracked, depot, p4)));
    if (!toRevert.length) {
      this.store.updateJob(bugId, { last_attempt_files: null });
      return [];
    }
    try {
      await p4.revert(toRevert);
    } catch (exc) {
      this.store.addEvent(`撤销上一次尝试的打开文件失败（交由 Agent 处理）: ${exc}`, "warn", bugId);
      return [];
    }
    this.store.updateJob(bugId, { last_attempt_files: null });
    return toRevert;
  }

  /** 记录当前尝试结束后遗留的 default 打开文件（只记 default：Agent 禁止 p4 change，
   *  编号 changelist 是其它 bug 的成功产物，绝不能碰）。
   *  strict=false（默认，保持原有语义）：清点查询失败时只记警告并保留已有记录。
   *  strict=true：查询失败直接抛出——调用方（provider 故障分支）必须拿到「能否确认工作区
   *  干净」的确定答案，否则会把无法归因的遗留文件当成可安全重试。 */
  private async recordAttemptEnd(bugId: string, p4: P4Client | null, strict = false): Promise<string[]> {
    let files = this.lastAttemptFiles(bugId);
    if (p4) {
      try {
        // 任务取消信号已经置位时，原 P4Client 也会被立即取消；结束清点必须独立
        // 于任务取消，才能登记刚才实际留下的 default 文件供下一次精确撤销。
        files = (await p4.forkForCleanup().opened("default", true))
          .filter((o) => o.changelist === "default")
          .map((o) => o.depot);
      } catch (error) {
        if (strict) {
          // 严格模式：不吞掉失败，也不覆盖已有记录（下方 updateJob 不会执行）。
          this.store.addEvent(`P4: 结束清点失败（严格模式，向上抛出）: ${String(error)}`, "warn", bugId);
          throw error;
        }
        // 查询失败时保留已有记录，不能以“未查到”覆盖成空数组，否则下次会把
        // 本 Bug 的遗留文件误判成无法归属的工作区垃圾。
        this.store.addEvent(`P4: 结束清点失败，保留已有遗留文件记录: ${String(error)}`, "warn", bugId);
      }
    }
    this.store.updateJob(bugId, { last_attempt_files: dumps(files) });
    return files;
  }

  /** 开/延长 provider 全局冷却（与任务失败分类解耦）。
   *  连续失败计数只在同一 kind 下累加：transient 与 quota/auth 的退避基数完全不同，
   *  混在一起会把一次限流的计数带进额度冷却（或反之），退避时长就失真了。 */
  private openProviderCooldown(failure: ProviderUnavailableError, bugId: string): number {
    const previous = this.store.peekProviderCooldown();
    const sameKind = String(previous?.kind ?? "") === failure.kind;
    const failures = sameKind ? Number(previous?.failures ?? 0) + 1 : 1;
    const kind = failure.kind;
    const cooldownMs = providerCooldownMs(kind, failures);
    const reason = failure.message.slice(0, 1000);
    this.store.setProviderCooldown({
      until_ms: Date.now() + cooldownMs,
      kind,
      reason,
      failures,
    });
    const needsHuman = kind === "quota" || kind === "auth";
    this.store.addEvent(
      `provider 不可用（${kind}，连续第 ${failures} 次）: 已全局冷却 ${Math.round(cooldownMs / 1000)}s，`
        + (needsHuman
          ? "这属于额度/鉴权问题，短期重试无意义，请补充额度或更换可用 Key；"
            + "可在管理台对该单点「重试」提前解除冷却"
          : "到期后自动恢复，无需人工操作")
        + `: ${reason}`,
      needsHuman ? "error" : "warn",
      bugId,
    );
    return cooldownMs;
  }

  /** provider 真的响应过（本次尝试成功，或以非 provider 原因失败）→ 退避计数归零。
   *  只在这两种结果下调用：provider 故障本身、以及被 cleanup 失败升级为工作区阻塞的
   *  provider 故障都不能清零，否则长期宕机时退避会一直被重置回最短间隔。 */
  private resetProviderBackoffAfterSuccess(): void {
    const stale = this.store.peekProviderCooldown();
    if (!stale) return;
    this.store.clearProviderCooldown();
    if (Number(stale.failures) > 0) {
      this.store.addEvent(
        `provider 已恢复响应：provider 退避计数归零（此前连续失败 ${Number(stale.failures)} 次）`,
        "info",
      );
    }
  }

  private async handleFailure(
    bug: Bug, exc: unknown, p4: P4Client | null, lastResult: AgentResult | null,
    checkpoint: Pick<RetryEvidenceEntry, "phase" | "context_key" | "investigation" | "investigation_progress"> = {},
  ): Promise<void> {
    const job = this.store.getJob(bug.id) ?? {};
    const attempts = Number(job.attempts ?? 0) + 1;
    const maxAttempts = Math.max(1, Number(this.config.max_attempts ?? 1));
    const willRetry = attempts < maxAttempts;
    const prevState = job.agent_state;
    const reason = String(exc).slice(0, 1000);

    // 记录证据：本次失败压缩成一条，追加到历史证据里（保留最近 N 条）
    const openedFiles = await this.recordAttemptEnd(bug.id, p4);
    const entry: RetryEvidenceEntry = {
      attempt: attempts,
      at: nowStr(),
      failure_reason: reason,
      opened_files: openedFiles,
      agent_summary: (lastResult?.summary ?? "").slice(0, 500),
      manual_assets: (lastResult?.manual_assets ?? []).map((a) => a.path),
      ...checkpoint,
      review_findings: checkpoint.phase === "review"
        ? loads<Record<string, unknown> | undefined>(job.review_findings as string, undefined) : undefined,
      partial_output: exc instanceof AgentTimeoutError || exc instanceof AgentInvestigationLimitError
        ? exc.partialOutput.slice(-32000) : (lastResult?.raw_output || "").slice(-16000),
    };
    const evidence = [...this.retryEvidenceEntries(bug.id), entry].slice(-_MAX_EVIDENCE_ENTRIES);
    const reviewerInfrastructureFailure = /Reviewer 异常退出/.test(reason);
    const hasPreservableChanges = Boolean(p4 && openedFiles.length && lastResult && hasCodeChanges(lastResult));

    // Agent 已经产出代码，但未能安全进入自动候选时，把最终一次改动移入编号
    // changelist 等待人工检查。范围偏差、输出协议错误、验证/评审失败都不能让
    // 文件继续留在 default，否则一个 Bug 会把整个后续队列连锁阻塞。
    // Reviewer 基础设施异常时立即保留；其它失败仅在重试耗尽后保留。
    if (hasPreservableChanges && (reviewerInfrastructureFailure || !willRetry)) {
      try {
        const desc = buildDescription(bug, lastResult!, reason, [
          "自动修复已产出代码，但未能安全进入自动候选",
          "本 changelist 仅用于保留候选改动，请人工检查后决定修改、提交或 revert",
        ]);
        const cl = await p4!.createPending(desc, openedFiles);
        this.store.updateJob(bug.id, {
          agent_state: "manual_review",
          changelist: cl,
          files: dumps(openedFiles),
          failure_reason: reason,
          attempts,
          retry_evidence: dumps(evidence),
          last_attempt_files: null,
          finished_at: nowStr(),
        });
        this.store.addEvent(
          `自动候选未通过，但已保留改动到 pending changelist ${cl}，未污染后续任务`,
          "warn",
          bug.id,
        );
        try {
          await this.tapd(this.workspaceOf(bug)).addComment(
            bug.id,
            `[TapdBugFixAgent] 已产出候选代码，但未能安全进入自动候选。\n` +
              `Perforce pending changelist: ${cl}（请人工检查后决定修改、提交或 revert）\n` +
              `失败原因: ${reason}`,
          );
        } catch (commentError) {
          this.store.addEvent(`回写候选保留评论出错: ${commentError}`, "error", bug.id);
        }
        return;
      } catch (preserveError) {
        this.store.addEvent(`保留失败候选到 pending changelist 失败: ${preserveError}`, "error", bug.id);
      }
    }

    this.store.updateJob(bug.id, {
      agent_state: willRetry ? "pending" : "failed",
      failure_reason: reason,
      attempts,
      retry_evidence: dumps(evidence),
      finished_at: willRetry ? null : nowStr(),
    });
    this.store.addEvent(
      `处理失败（第 ${attempts}/${maxAttempts} 次）: ${reason}` +
        (willRetry ? "，将自动重试" : "，已停止重试"),
      "error",
      bug.id,
    );

    // Tapd 失败评论只在最后一次失败发，避免刷屏
    if (willRetry) return;
    if (prevState === "failed") {
      this.store.addEvent("（已处于 failed，跳过重复失败评论）", "info", bug.id);
      return;
    }
    try {
      const ws = this.workspaceOf(bug);
      await this.tapd(ws).addComment(
        bug.id,
        `[TapdBugFixAgent] 自动修复失败（已尝试 ${attempts} 次）:\n${reason}`,
      );
    } catch (exc2) {
      this.store.addEvent(`回写 Tapd 失败评论出错: ${exc2}`, "error", bug.id);
    }
  }

  // ------------------------------------------------------------------
  // Web 展示（合并 Tapd 实时 bug 与本地处理状态）
  // ------------------------------------------------------------------
  private jobRow(bug: Bug, includeDesc = false): Record<string, unknown> {
    const job = this.store.getJob(bug.id) ?? {};
    const item: Record<string, unknown> = {
      bug_id: String(bug.id), // 大整数（>2^53）跨 JSON 会丢精度，必须字符串传输
      workspace_id: bug.workspace_id,
      title: bug.title,
      priority: bug.priority,
      priority_label: bug.priority_label,
      severity: bug.severity,
      module: bug.module,
      tapd_status: bug.status,
      created_at: bug.created,
      url: bugUrl(bug.workspace_id, bug.id),
      agent_state: job.agent_state,
      changelist: job.changelist !== undefined && job.changelist !== null ? Number(job.changelist) : null,
      agent: job.agent,
      model: job.model,
      started_at: job.started_at,
      finished_at: job.finished_at,
      failure_reason: job.failure_reason,
      attempts: Number(job.attempts ?? 0),
      has_local: Boolean(Object.keys(job).length),
    };
    if (includeDesc) item.description = bug.description;
    return item;
  }

  /** 管理台列表：Tapd 上分配给我的有效 bug + 本地处理状态，按优先级排序。
   *  本地有记录但已不在 Tapd「我的」列表的 bug 也展示（标 tapd_missing），
   *  否则人工重试后该行直接从页面消失，看起来就像「重试没生效」。 */
  async listBugsForWeb(): Promise<Record<string, unknown>[]> {
    const ranked: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const b of await this.fetchMyBugs()) {
      if (this.config.exclude_status.includes(b.status)) continue;
      seen.add(b.id);
      const row = this.jobRow(b);
      row._rank = priorityRank(this.config, b);
      ranked.push(row);
    }
    for (const job of this.store.listJobs()) {
      const id = String(job.bug_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const bug = this.bugFromJobSnapshot(job);
      const row = this.jobRow(bug);
      row.tapd_missing = true; // 前端打「不在 Tapd 列表」标
      row._rank = priorityRank(this.config, bug);
      ranked.push(row);
    }
    ranked.sort((a, b) => {
      const byRank = Number(a._rank) - Number(b._rank);
      if (byRank !== 0) return byRank;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    });
    for (const r of ranked) delete (r as Record<string, unknown>)._rank;
    return ranked;
  }

  /** 管理台详情：合并 Tapd 实时字段与本地处理记录；未处理也能查看。 */
  async bugDetailForWeb(bugId: string): Promise<Record<string, unknown> | null> {
    const bug = await this.fetchBugForManual(bugId);
    const job = this.store.getJob(bugId);
    if (!bug && !job) return null;
    const detail: Record<string, unknown> = bug ? this.jobRow(bug, true) : {};
    // 正在处理的 bug：附上编排器内存里的「当前阶段 + 该阶段模型」（不落库、不新增 DB 列），
    // 详情抽屉据此展示阶段；否则阶段未知，前端显示「—」。
    if (this.currentBugId === bugId) Object.assign(detail, this.currentStageInfo());
    detail.repair_attempts = this.store.audit.attempts(bugId);
    detail.repair_candidates = this.store.audit.candidates(bugId);
    detail.candidate_feedback = this.store.audit.feedback(bugId);
    if (job) {
      Object.assign(detail, job); // 本地处理字段优先（files 等保持 JSON 字符串，前端自行 parse）
      detail.bug_id = String(detail.bug_id);
      if (detail.changelist !== null && detail.changelist !== undefined) {
        detail.changelist = Number(detail.changelist);
      }
      // 拆分：debug 级是 Agent 实时进度（逐行动作），单独给前端做醒目的进度区
      const allEvents = this.store.listEvents(bugId, 300);
      detail.progress = allEvents.filter((e) => e.level === "debug");
      detail.events = allEvents.filter((e) => e.level !== "debug");
    } else {
      detail.files = "[]";
      detail.manual_assets = "[]";
      detail.events = [];
      detail.progress = [];
      detail.generated_description = "";
    }
    // job 原始行/事件行里的 INTEGER 列是 BigInt（safeIntegers），统一转 number 才能 res.json
    return jsonSafe(detail) as Record<string, unknown>;
  }

  // ------------------------------------------------------------------
  // 人工操作（web）
  // ------------------------------------------------------------------
  /** 重置 job 为全新待处理状态（单 bug 重试与「重试全部失败」共用）。
   *  last_attempt_files 有意保留：cleanupStaleAttempt 要靠它撤销遗留打开文件。 */
  private resetJobForRetry(bugId: string): void {
    // 人工重试是明确的人工恢复信号：provider 冷却（尤其 quota/auth 长冷却）应被提前解除，
    // 否则用户点了重试却什么都没发生（循环还在睡）。同时清零连续失败计数，从最短退避重来。
    if (this.store.clearProviderCooldown()) {
      this.store.addEvent("人工重试：已提前解除 provider 全局冷却并清零退避", "info", bugId);
      this.wake();
    }
    this.store.updateJob(bugId, {
      agent_state: "pending",
      attempts: 0,
      failure_reason: null,
      changelist: null,
      generated_description: null,
      files: null,
      manual_assets: null,
      finished_at: null,
      // 保留中断轨迹和调查检查点；人工重试只重置本轮尝试次数。
      admission_score: null,
      verification: null,
      review_findings: null,
    });
  }

  /** 中断当前正在处理的尝试（如果重试/跳过的恰是正在跑的 bug）。
   *  注意必须立刻换一个新 CancelEvent：在跑的 agent 持有旧事件引用（set 即取消），
   *  后续 bug 领的是 this.cancelEvent——不换的话下一个 bug 会被瞬间误取消。 */
  private cancelCurrentAttempt(): void {
    if (this.currentBugId === null) return;
    this.cancelEvent.set();
    this.cancelEvent = new CancelEvent();
  }

  async retryBug(bugId: string): Promise<boolean> {
    const job = this.store.getJob(bugId);
    if (!job) {
      // 未处理 bug「重试」= 确保可被处理（它本来就在队列里），幂等成功
      if (!(await this.fetchBugForManual(bugId))) return false;
      this.store.addEvent(`人工触发处理 bug ${bugId}`, "info", bugId);
      return true;
    }
    if (this.currentBugId === bugId) this.cancelCurrentAttempt(); // 正在跑：先中断本次尝试
    const wasSkipped = job.agent_state === "skipped";
    this.resetJobForRetry(bugId);
    this.store.addEvent(
      wasSkipped ? `人工从跳过恢复 bug ${bugId}（已重置为待处理）` : `人工触发重试 bug ${bugId}`,
      "info",
      bugId,
    );
    return true;
  }

  /** 把所有 failed 任务重置为待处理（web「重试全部失败」按钮）。返回重置数量。
   *  provider_unavailable 一并重置：它表示「外部服务暂时不可用」，不是修复失败，
   *  否则用户只能靠「清除并重新同步」才能让这批单据重新入队。 */
  retryAllFailed(): number {
    // 入口先统一解除 provider 冷却：这是用户「我现在就要重试」的明确信号。
    // 必须在 target 收集之前做——刚「清除并重新同步」后队列可能全是 pending，
    // targets 为空，如果只在循环里解除，按钮点了等于没反应（提示就不成立）。
    if (this.store.clearProviderCooldown()) {
      this.store.addEvent("人工重试全部失败：已提前解除 provider 全局冷却并清零退避", "info");
    }
    const targets = [
      ...this.store.listJobs("failed"),
      ...this.store.listJobs("provider_unavailable"),
    ];
    for (const job of targets) {
      this.resetJobForRetry(String(job.bug_id));
    }
    if (targets.length) {
      this.store.addEvent(`人工重试全部失败任务（${targets.length} 个，已重置为待处理）`, "info");
    }
    this.wake(); // 冷却可能刚被解除，立即唤醒正在 sleep 的工作循环
    return targets.length;
  }

  /** 清空可重试任务并从 Tapd 强制重新同步（候选产物、changelist 关联和人工质量反馈保留）。
   *  - 仅非运行状态可用（web 按钮已按控制态禁用；此处是后端的同一道闸，
   *    拦住绕过 UI 直调 API 的情况）
   *  - failed/pending/blocked 等可重试记录清除；已产出候选或已有人工结论的记录保留
   *  - 拉到的每个 bug 落一条 pending job（排除 Tapd 侧终态），worker 从头按优先级处理
   *  返回清除、保留和同步数量。 */
  async resyncFromTapd(): Promise<{ cleared: number; preserved: number; synced: number }> {
    if (this.state === "running") {
      throw new Error("运行中不可清除同步：请先停止自动处理（⏹ 关闭）");
    }
    if (this.currentBugId !== null) {
      throw new Error(`当前 bug ${this.currentBugId} 仍在停止中，请等待其退出后再清除同步`);
    }
    const { cleared, preserved } = this.store.deleteRetryableJobs(_RESYNC_PRESERVED_STATES);
    this.resetTapdClients(); // 清缓存 + 断开旧 MCP 连接，强制下一次真实拉取
    this.lastFetch = 0;
    this.lastFetchResult = null;
    this.lastFetchReliable = true;

    const bugs = await this.fetchMyBugs(); // 缓存已作废，这里是真实重拉
    let synced = 0;
    for (const bug of bugs) {
      if (this.config.exclude_status.includes(bug.status)) continue;
      const existing = this.store.getJob(bug.id);
      if (existing && _RESYNC_PRESERVED_STATES.includes(String(existing.agent_state))) {
        synced += 1;
        continue;
      }
      this.store.upsertJob(bug, { agent_state: "pending" });
      this.store.audit.enroll({ bug_id: bug.id, workspace_id: bug.workspace_id, input: buildBugContext(bug), metadata: {} });
      synced += 1;
    }
    this.store.addEvent(
      `人工重新同步：清空 ${cleared} 条可重试记录，保留 ${preserved} 条候选/人工结论，` +
        `从 Tapd 同步到 ${synced} 个 bug`,
      "warn",
    );
    // 冷却记录属于「外部服务健康状态」，不随任务清空而删除。保留时必须明确告知，
    // 否则用户会以为重新同步后马上就会开始跑，实际还在冷却期。
    const cooldown = this.store.activeProviderCooldown();
    if (cooldown) {
      this.store.addEvent(
        `注意：provider 全局冷却仍在生效（${cooldown.kind}），`
          + `约 ${Math.max(1, Math.round((cooldown.until_ms - Date.now()) / 1000))}s 后自动恢复；`
          + "如需立即重试，请点「重试全部失败」或对具体单据点「重试」以提前解除冷却",
        "warn",
      );
    }
    this.wake(); // 立即唤醒工作循环（若有正在 sleep 的轮询）
    return { cleared, preserved, synced };
  }

  async skipBug(bugId: string): Promise<boolean> {
    const job = this.store.getJob(bugId);
    if (!job) {
      // 未处理 bug：建一条 skipped 记录，worker 就不会再抓它
      const bug = await this.fetchBugForManual(bugId);
      if (!bug) return false;
      this.store.upsertJob(bug, { agent_state: "skipped", finished_at: nowStr() });
      this.store.addEvent(`人工跳过 bug ${bugId}（未处理，不再自动处理）`, "info", bugId);
      return true;
    }
    if (this.currentBugId === bugId) this.cancelCurrentAttempt(); // 正在跑：先中断，否则跑完会覆盖 skipped
    this.store.updateJob(bugId, { agent_state: "skipped", finished_at: nowStr() });
    this.store.addEvent(`人工跳过 bug ${bugId}`, "info", bugId);
    return true;
  }

  /** 模型解析唯一入口：该角色的模型覆盖（裸名自动补 provider 前缀），未配置则回落
   *  pi.provider 默认模型——与 PiAgent.run 的解析顺序一致（调用用的模型 == 展示的模型）。
   *  角色缺失（准备/准入/机器验证等编排阶段）返回空串：这些阶段不调用模型，
   *  管理台按「—」展示，不沿用上一阶段的模型假装在跑模型。 */
  private modelForRole(role: AgentRole | null): string {
    return role ? (agentRoleModel(this.config, role) || effectivePiModel(this.config.pi)) : "";
  }

  /** coordinator 角色的统一调用封装：只读、无工具、严格 JSON、失败降级。
   *
   *  - 权限收敛：`sandboxMode: "read-only"` + `tools: []` + 不挂任何 MCP + 不传 media，
   *    因此它不可能产生任何副作用，也看不到 prompt 之外的信息。
   *  - 一次调用、一次解析：不重试、不缓存。超时 / 非零退出 / 输出不是严格 JSON /
   *    字段类型不符，统一记一条 warn 进度并返回 null（调用方按「本次没有建议」继续）。
   *  - **取消必须传播**：AgentCancelledError（人工暂停/关闭）与 ProviderUnavailableError
   *    （provider 故障，编排器要据此开全局冷却）原样向上抛，绝不降级成「没有建议」——
   *    否则一单会在被取消后继续跑完整流程。
   *  - 它的产物只用于 prompt/描述的附加文字，任何返回值都不会改变编排决策。 */
  private async runCoordinator<T>(opts: {
    prompt: string;
    auditAttemptId: string;
    phase: "coordinator_plan" | "coordinator_summary";
    bugId: string;
    repoDir: string;
    timeoutS: number;
    parse: (output: string) => T | null;
    degradeMessage: string;
  }): Promise<T | null> {
    const degrade = (reason: string): null => {
      this.store.addEvent(`${opts.degradeMessage}: ${reason}`, "warn", opts.bugId);
      this.store.audit.event(opts.auditAttemptId, opts.phase, {
        role: "coordinator", degraded: true, reason,
      });
      return null;
    };
    try {
      const result = await new PiAgent(this.config).run({
        prompt: opts.prompt,
        repoDir: opts.repoDir,
        role: "coordinator",
        timeoutS: opts.timeoutS,
        tools: [],
        sandboxMode: "read-only",
        mcpServers: [],
        requiredMcpServers: [],
        media: [],
        // 纯文本整理任务：关掉推理可以显著降低超时概率（协调者的产出不允许被当成结论）。
        thinkingLevel: "off",
        onProgress: (msg: string) => this.store.addEvent(msg, "debug", opts.bugId),
        onAudit: (event: Record<string, unknown>) =>
          this.store.audit.event(opts.auditAttemptId, "agent", { phase: opts.phase, ...event }),
        cancelEvent: this.cancelEvent,
      });
      if (!result.ok) return degrade(`调用异常退出(${result.exit_code})`);
      const parsed = opts.parse(result.raw_output || result.log || result.summary);
      if (!parsed) return degrade("输出不是严格 JSON 或字段不符合约定");
      return parsed;
    } catch (error) {
      if (error instanceof AgentCancelledError || error instanceof ProviderUnavailableError) throw error;
      if (error instanceof AgentTimeoutError) return degrade(`超过 ${opts.timeoutS}s 时限`);
      if (error instanceof AgentInvestigationLimitError) return degrade("达到工具预算");
      return degrade(`调用失败: ${(error as Error).message}`);
    }
  }

  /** 设置「当前阶段」并同步该阶段实际生效的模型。
   *  - 阶段信息只保存在内存里（与 currentBugId 同一生命周期），不新增 DB 列：
   *    重新启动后当前阶段本就重新开始计算，历史值没有意义。 */
  private applyStage(stage: WorkerStage): void {
    this.currentStage = stage;
    this.currentStageModel = this.modelForRole(stageAgentRole(stage));
  }

  /** 阶段内的临时模型切换（不改阶段标签）：用于调查/实施阶段的 role:"recovery" 收尾子调用——
   *  状态条上的「当前阶段」仍是调查/实施，但「模型」必须显示那一刻真正在跑的 recovery 模型。 */
  private setStageModelForRole(role: AgentRole): void {
    if (!this.currentStage) return; // 阶段已清空（异常/结束时迟到的切换）：不复活展示状态
    this.currentStageModel = this.modelForRole(role);
  }

  /** 把阶段模型还原成该阶段自身的模型（applyStage 的模型部分），供临时切换后调用。 */
  private restoreStageModel(): void {
    if (!this.currentStage) return;
    this.currentStageModel = this.modelForRole(stageAgentRole(this.currentStage));
  }

  /** 一次尝试结束（成功/失败/取消/异常）后清空「当前阶段」，管理台回到「—」占位。
   *  processBug 自己的 finally 调用它：无论从哪个入口进来（runLoop 还是测试/CLI 直接调用），
   *  阶段展示生命周期都完整，不会残留上一单的阶段与模型。 */
  private clearStage(): void {
    this.currentStage = null;
    this.currentStageModel = "";
  }

  /** 当前阶段 + 该阶段模型（管理台「处理中 N」分组标题栏展示用）。关键名刻意带 current_ 前缀，避免与任务行字段
   *  （stage / label / model 等）在 JSON 合并时互相覆盖；未领取任务时 stage 为 null。 */
  currentStageInfo(): { current_stage: WorkerStage | null; current_stage_label: string; current_model: string } {
    const stage = this.currentStage;
    return {
      current_stage: stage,
      current_stage_label: stage ? _STAGE_LABEL[stage] : "",
      current_model: this.currentStageModel,
    };
  }

  status(): Record<string, unknown> {
    // provider_cooldown：供管理台显示「provider 不可用，冷却中」以及人工解除入口。
    // 只暴露仍在生效的冷却；kind/剩余秒数/原因足以让用户判断是否需要补额度或换 Key。
    const cooldown = this.store.activeProviderCooldown();
    return {
      control: this.store.getControl(),
      current_bug: this.currentBugId,
      // 当前阶段与该阶段实际生效的模型：管理台「处理中 N」分组标题栏直接展示，避免用户猜「现在跑到哪一步」。
      current_stage: this.currentStageInfo(),
      jobs_total: this.store.jobCount(),
      queued: this.store.queuedCount(),
      counts: this.store.jobStateCounts(),
      provider_cooldown: cooldown
        ? {
          kind: cooldown.kind,
          reason: cooldown.reason.slice(0, 300),
          failures: Number(cooldown.failures),
          until_ms: cooldown.until_ms,
          remaining_s: Math.max(0, Math.round((cooldown.until_ms - Date.now()) / 1000)),
        }
        : null,
    };
  }
}

export { P4Error, TapdError };
