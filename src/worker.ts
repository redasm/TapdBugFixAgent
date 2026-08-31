/** 编排工作线程：调查、修复、验证、评审、pending changelist 与 Tapd 回写。 */

import type { AdditionalDirConfig, Config, RepoConfig, WorkspaceConfig } from "./config.js";
import { priorityRank } from "./config.js";
import type { AgentResult, Bug, RetryEvidenceEntry } from "./models.js";
import { bugUrl, dumps, hasCodeChanges, hasManualAssets, loads } from "./models.js";
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
  formatRetryEvidence,
} from "./agent.js";
import {
  createCodingAgent,
  effectiveAgentModel,
  selectedAgentBackend,
  type CodingAgent,
} from "./agentBackend.js";
import { nowStr, type StateStore } from "./state.js";
import { assessFixability } from "./quality.js";
import {
  automatableManualKeywords,
  configuredManualKeywords,
  enabledMcpServerNames,
  mcpServerNamesMatchingText,
} from "./mcpServers.js";
import {
  IMPLEMENTATION_OUTPUT_SCHEMA,
  INVESTIGATION_OUTPUT_SCHEMA,
  buildImplementationPrompt,
  buildInvestigationPrompt,
  buildInvestigationRecoveryPrompt,
  parseInvestigation,
  type InvestigationResult,
} from "./repairWorkflow.js";
import {
  buildReviewPrompt,
  formatReviewerFeedback,
  parseReviewResult,
  type ReviewResult,
} from "./review.js";
import { createTapdClient, type TapdBackend, TapdError } from "./tapd.js";
import {
  GitWorkspace,
  type GitBranchSession,
  type GitFinalizeResult,
} from "./git.js";

const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    note: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["low", "medium", "high"] },
          title: { type: "string" },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          evidence: { type: "string" },
          required_action: { type: "string" },
        },
        required: ["severity", "title", "file", "line", "evidence", "required_action"],
        additionalProperties: false,
      },
    },
  },
  required: ["approved", "note", "findings"],
  additionalProperties: false,
} as const;

// 终态：已处理（不会自动重新处理）
const _TERMINAL_STATES = new Set([
  "candidate", "candidate_partial", "verified", "review_pending",
  "accepted", "accepted_modified", "rejected", "reopened",
  "needs_info", "manual_review", "blocked_workspace",
  "manual_only", "failed", "skipped",
]);
const _FETCH_CACHE_MS = 60000;
const _MAX_EVIDENCE_ENTRIES = 6; // 重试证据最多保留最近 6 次失败

/** 工作区中存在无法安全归属当前 Bug 的改动；这是操作阻塞，不应消耗模型修复次数。 */
class WorkspaceBlockedError extends Error {}

/** 调查在有限预算内无法收敛；保留证据并等待人工补充，不重复跑相同搜索。 */
class InvestigationBlockedError extends Error {}

const _AGENT_COMMAND_BUDGET = 100;
const _AGENT_REPEAT_LIMIT = 3;
const _READ_ONLY_COMMAND_BUDGET = 50;

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
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;
  private wakeResolvers: Array<() => void> = [];
  private cleanP4Baselines = new Set<string>();

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
    for (const job of this.store.listJobs("in_progress")) {
      const id = String(job.bug_id);
      this.store.updateJob(id, { agent_state: "pending", started_at: null });
      this.store.addEvent(
        `上次进程遗留的处理中任务已回退为待处理（进程启动对账）`,
        "info",
        id,
      );
    }
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
    try {
      const ws = this.config.workspaces[0];
      const bug = await this.tapd(ws).getBug(bugId);
      if (!bug.title.trim() && !bug.status.trim()) return { kind: "missing" };
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
    for (const ws of this.config.workspaces) {
      try {
        const fetched = await this.tapd(ws).listBugs(ws.owner);
        for (const b of fetched) b.workspace_id = ws.workspace_id;
        bugs.push(...fetched);
      } catch (exc) {
        this.store.addEvent(`workspace ${ws.workspace_id} 拉取失败: ${exc}`, "error");
      }
    }
    this.lastFetch = now;
    this.lastFetchResult = bugs;
    return bugs;
  }

  /** 分配给我的、未处理的 bug，按优先级排序（数字小优先，再按创建时间）。
   *  除 Tapd「我的」列表外，还并入本地 pending 但已不在该列表的 bug（改派/翻页遗漏/
   *  接口波动）：人工重试后必须仍会被处理。Tapd 侧已终态（resolved/closed 等）的不复活。 */
  async fetchActionable(): Promise<Bug[]> {
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
    for (const job of this.store.listJobs("pending")) {
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
      this.currentBugId = null;
    }
    return true;
  }

  /** 同步处理一批（CLI 用，忽略控制态）。 */
  async runBatch(limit?: number): Promise<number> {
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

  private verificationCommands(repo: RepoConfig): string[] {
    return [
      ...repo.verify_cmds.map((command) => `[project] ${command}`),
      ...(repo.additional_dirs ?? []).flatMap((dir) =>
        dir.verify_cmds.map((command) => `[${dir.name.toLowerCase()}] ${command}`)),
    ];
  }

  private async prepareGitAttempts(repo: RepoConfig, ws: WorkspaceConfig): Promise<GitAttempt[]> {
    const attempts: GitAttempt[] = [];
    try {
      for (const config of repo.additional_dirs ?? []) {
        this.store.addEvent(
          `Git ${config.name}: 开始检查附加仓库（${config.path}，基线 ${config.base_branch}）`,
          "info",
          this.currentBugId ?? undefined,
        );
        const workspace = new GitWorkspace(config.path, config.ignore_paths ?? []);
        const author = config.author.trim() || String(this.config.p4.user ?? "").trim() || ws.owner.trim();
        const session = await workspace.prepareBranch(config.base_branch, author);
        attempts.push({ config, workspace, session });
        this.store.addEvent(
          `Git ${config.name}: 仓库连接及状态检查成功，已创建分支 ${session.branch}`,
          "info",
          this.currentBugId ?? undefined,
        );
        if (config.ignore_paths?.length) {
          this.store.addEvent(
            `Git ${config.name}: 已忽略本地生成路径 ${config.ignore_paths.join(", ")}`,
            "info",
            this.currentBugId ?? undefined,
          );
        }
      }
      return attempts;
    } catch (error) {
      for (const attempt of attempts.reverse()) {
        try { await attempt.workspace.rollback(attempt.session); } catch { /* 保留原始异常 */ }
      }
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

  private async verifyCandidate(
    p4: P4Client,
    repo: RepoConfig,
    gitAttempts: GitAttempt[],
    opened?: OpenedFile[] | null,
    plannedFiles?: string[],
  ): Promise<{ opened: OpenedFile[]; gitFiles: string[]; diff: string; summary: string; verified: boolean }> {
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
    const p4Diff = actualOpened.length
      ? await p4.diffUnified(actualOpened.map((item) => item.depot))
      : "";
    const diff = [
      p4Diff ? `### project (Perforce)\n${p4Diff}` : "",
      ...gitChanges.filter((item) => item.diff).map(({ attempt, diff: gitDiff }) =>
        `### ${attempt.config.name.toLowerCase()} (Git: ${attempt.session.branch})\n${gitDiff}`),
    ].filter(Boolean).join("\n\n");
    const scope = assessPatchScope(
      allFiles,
      diff,
      this.config.quality.max_changed_files,
      this.config.quality.max_diff_lines,
    );
    if (!scope.ok) throw new VerificationError(scope.reasons.join("；"));
    const pipelines = [
      { name: "project", result: await runVerificationPipeline(
        repo.path, repo.verify_cmds, this.config.quality.require_verification,
      ) },
    ];
    for (const attempt of gitAttempts) {
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
    if (failed) {
      throw new Error(`测试未通过 (${failed.name}): ${failed.result.summary.slice(-1000)}`);
    }
    return {
      opened: actualOpened,
      gitFiles: rootedGitFiles,
      diff,
      summary: pipelines.map(({ name, result }) => `[${name}] ${result.summary}`).join("\n"),
      verified: pipelines.every(({ result }) => result.ok && result.configured),
    };
  }

  private async reviewCandidate(
    reviewer: CodingAgent,
    p4: P4Client,
    bug: Bug,
    investigation: InvestigationResult,
    diff: string,
    verificationSummary: string,
    additionalDirs: string[],
  ): Promise<ReviewResult> {
    const result = await reviewer.run({
      prompt: buildReviewPrompt({ bug, investigation, diff, verificationSummary }),
      repoDir: p4.path,
      additionalDirs,
      timeoutS: Math.min(this.config.agent_timeout_s, 600),
      tools: ["read", "grep", "find", "ls"],
      sandboxMode: "read-only",
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      model: this.config.review.model || undefined,
      maxCommandExecutions: _READ_ONLY_COMMAND_BUDGET,
      repeatedCommandLimit: _AGENT_REPEAT_LIMIT,
      cancelEvent: this.cancelEvent,
      onProgress: (msg) => this.store.addEvent(`Reviewer ${msg}`, "debug", bug.id),
    });
    if (!result.ok) {
      throw new VerificationError(`Reviewer 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
    }
    return parseReviewResult(result.raw_output || result.log || result.summary);
  }

  async processBug(bug: Bug): Promise<void> {
    this.store.upsertJob(bug, { agent_state: "in_progress", started_at: nowStr() });
    this.store.addEvent(`开始处理 bug ${bug.id}: ${bug.title}`, "info", bug.id);
    let p4: P4Client | null = null;
    let activeRepo: RepoConfig | null = null;
    let gitAttempts: GitAttempt[] = [];
    let lastResult: AgentResult | null = null;
    try {
      const repo = this.resolveRepo(bug);
      if (!repo) {
        throw new Error("未配置该 bug 对应的仓库映射（workspaces[].repos[]）");
      }
      activeRepo = repo;

      const mcpManualKeywords = configuredManualKeywords(this.config.mcp_servers);
      const admission = assessFixability(
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
        const state = admission.disposition === "needs_info"
          ? "needs_info"
          : admission.disposition === "manual_only" ? "manual_only" : "manual_review";
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
      const backend = selectedAgentBackend(this.config);
      const model = effectiveAgentModel(this.config, backend);
      this.store.updateJob(bug.id, { agent: backend, model });

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
      const debris = defaultOpened.map((o) => o.depot).filter((f) => !stale.includes(f));
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

      gitAttempts = await this.prepareGitAttempts(repo, this.workspaceOf(bug));
      for (const attempt of gitAttempts) {
        this.store.addEvent(
          `Git ${attempt.config.name} 已从 ${attempt.session.baseBranch} 创建分支 ${attempt.session.branch}`,
          "info",
          bug.id,
        );
      }

      // ---- 带证据的重试：把之前的失败记录压缩成提示，喂给全新上下文的 Agent ----
      const retryText = formatRetryEvidence(this.retryEvidenceEntries(bug.id));
      const attempts = Number(this.store.getJob(bug.id)?.attempts ?? 0) + 1;
      const agent = createCodingAgent(this.config, backend);
      const reviewerBackend = selectedAgentBackend(this.config, this.config.review.backend);
      const reviewer = this.config.review.enabled
        ? createCodingAgent(this.config, reviewerBackend)
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
      const additionalDirs = this.additionalPaths(repo);
      if (mcpServerNames.length) {
        this.store.addEvent(
          `MCP: 已向 ${backend} Agent 注入配置：${mcpServerNames.join(", ")}；实际连接状态将在 Agent 启动/调用时继续输出`,
          "info",
          bug.id,
        );
      }
      this.store.addEvent("调用只读调查 Agent：定位根因、证据与最小修改范围", "info", bug.id);
      const investigationPrompt = buildInvestigationPrompt(
        bug, repo.name, repo.path, resourceMcpEnabled, workspaceRoots,
      );
      const investigationRunOptions = {
        repoDir: repo.path,
        additionalDirs,
        timeoutS: Math.min(this.config.agent_timeout_s, 600),
        tools: ["read", "grep", "find", "ls"],
        sandboxMode: "read-only" as const,
        outputSchema: INVESTIGATION_OUTPUT_SCHEMA,
        requiredMcpServers: investigationMcpServers,
        maxCommandExecutions: _READ_ONLY_COMMAND_BUDGET,
        repeatedCommandLimit: _AGENT_REPEAT_LIMIT,
        onProgress: (msg: string) => this.store.addEvent(msg, "debug", bug.id),
        cancelEvent: this.cancelEvent,
      };
      let investigated: AgentResult;
      try {
        investigated = await agent.run({
          prompt: investigationPrompt,
          ...investigationRunOptions,
        });
      } catch (error) {
        if (error instanceof AgentInfrastructureError) {
          throw new WorkspaceBlockedError(error.message);
        }
        if (error instanceof AgentInvestigationLimitError) {
          throw new InvestigationBlockedError(error.message);
        }
        if (error instanceof AgentTimeoutError) {
          throw new InvestigationBlockedError(error.message);
        }
        throw error;
      }
      if (!investigated.ok) {
        throw new Error(`调查 Agent 异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`);
      }
      let investigation: InvestigationResult = parseInvestigation(
        investigated.raw_output || investigated.log || investigated.summary,
        admission.context.diagnostic_links,
      );
      if (!investigation.ok && !investigation.blocked_reasons.length) {
        this.store.addEvent(
          "调查 Agent 仅返回过程说明或结构化结果不完整，正在原线程强制收敛（不计入 Bug 重试）",
          "warn",
          bug.id,
        );
        try {
          investigated = await agent.run({
            prompt: buildInvestigationRecoveryPrompt(
              investigationPrompt,
              investigated.raw_output || investigated.log || investigated.summary,
              investigation.validation_errors,
            ),
            ...investigationRunOptions,
          });
        } catch (error) {
          if (error instanceof AgentInfrastructureError) throw new WorkspaceBlockedError(error.message);
          if (error instanceof AgentInvestigationLimitError || error instanceof AgentTimeoutError) {
            throw new InvestigationBlockedError(error.message);
          }
          throw error;
        }
        if (!investigated.ok) {
          throw new InvestigationBlockedError(
            `调查 Agent 补充轮异常退出(${investigated.exit_code}): ${investigated.log.slice(-500)}`,
          );
        }
        investigation = parseInvestigation(
          investigated.raw_output || investigated.log || investigated.summary,
          admission.context.diagnostic_links,
        );
      }
      if (!investigation.ok) {
        const reason = [...investigation.blocked_reasons, ...investigation.validation_errors].join("；");
        throw new InvestigationBlockedError(
          "调查阶段未形成可靠修复证据: " + (reason || "输出不可解析"),
        );
      }
      this.store.addEvent(
        `调查完成：置信度 ${investigation.confidence}，计划修改 ${investigation.planned_files.length} 个文件`,
        "info",
        bug.id,
      );
      this.store.updateJob(bug.id, { investigation });
      const p4Targets = p4ReconcileTargets(investigation.planned_files);
      if (p4Targets.length) {
        try {
          await p4.sync(p4Targets);
        } catch (error) {
          if (error instanceof P4SyncTimeoutError) {
            throw new WorkspaceBlockedError(
              `P4 精确同步超时，未进入修改阶段；请检查 P4 服务或工作区后人工重试: ${error.message}`,
            );
          }
          throw error;
        }
      } else {
        this.store.addEvent(
          "P4: planned_files 不包含 project 路径，本次无需同步 P4 文件",
          "debug",
          bug.id,
        );
      }
      const prompt = buildImplementationPrompt({
        bug,
        repoName: repo.name,
        repoPath: repo.path,
        verifyCommands: this.verificationCommands(repo),
        investigation,
        retryEvidence: retryText,
        reviewerFeedback: "",
        unrealMcpEnabled: resourceMcpEnabled,
        workspaceRoots,
      });
      this.store.addEvent(
        retryText
          ? `调用编码 Agent（${backend}）（第 ${attempts} 次尝试，注入上次失败证据）`
          : `调用编码 Agent（${backend}）`,
        "info",
        bug.id,
      );
      let result = await agent.run({
        prompt,
        repoDir: repo.path,
        additionalDirs,
        timeoutS: this.config.agent_timeout_s,
        sandboxMode: "workspace-write",
        outputSchema: IMPLEMENTATION_OUTPUT_SCHEMA,
        requiredMcpServers: resourceMcpServers,
        maxCommandExecutions: _AGENT_COMMAND_BUDGET,
        repeatedCommandLimit: _AGENT_REPEAT_LIMIT,
        onProgress: (msg) => this.store.addEvent(msg, "debug", bug.id),
        cancelEvent: this.cancelEvent,
      });
      if (!result.ok) {
        throw new Error(`修复 Agent 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
      }
      if (result.blocked_reasons.length) {
        throw new VerificationError("修复 Agent 报告仍有阻塞项: " + result.blocked_reasons.join("；"));
      }
      lastResult = result;
      const manualAssets = new Map(result.manual_assets.map((asset) => [asset.path, asset]));
      if (result.manual_assets.length) {
        this.store.addEvent(`识别到需人工处理资源 ${result.manual_assets.length} 项`, "info", bug.id);
      }

      // ---- 验证门 ----
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
        let verified = await this.verifyCandidate(
          p4, repo, gitAttempts, opened, investigation.planned_files,
        );
        opened = verified.opened;
        result.changed_files = [
          ...opened.map((item) => `project:${item.depot}`),
          ...verified.gitFiles,
        ];
        testOut = verified.summary;
        verificationPassed = verified.verified;
        this.store.updateJob(bug.id, { verification: verified });
        if (this.config.review.enabled && verificationPassed) {
          let review = await this.reviewCandidate(
            reviewer!,
            p4,
            bug,
            investigation,
            verified.diff,
            verified.summary,
            additionalDirs,
          );
          this.store.updateJob(bug.id, { review_findings: review });
          let fixRound = 0;
          while (!review.approved && fixRound < this.config.review.max_fix_rounds) {
            fixRound += 1;
            const feedback = formatReviewerFeedback(review);
            this.store.addEvent(`Reviewer 拒绝候选，开始第 ${fixRound} 轮定向修正`, "warn", bug.id);
            result = await agent.run({
              prompt: buildImplementationPrompt({
                bug,
                repoName: repo.name,
                repoPath: repo.path,
                verifyCommands: this.verificationCommands(repo),
                investigation,
                retryEvidence: retryText,
            reviewerFeedback: feedback,
            unrealMcpEnabled: resourceMcpEnabled,
            workspaceRoots,
          }),
              repoDir: repo.path,
              additionalDirs,
              timeoutS: this.config.agent_timeout_s,
              sandboxMode: "workspace-write",
              outputSchema: IMPLEMENTATION_OUTPUT_SCHEMA,
              requiredMcpServers: resourceMcpServers,
              maxCommandExecutions: _AGENT_COMMAND_BUDGET,
              repeatedCommandLimit: _AGENT_REPEAT_LIMIT,
              onProgress: (msg) => this.store.addEvent(msg, "debug", bug.id),
              cancelEvent: this.cancelEvent,
            });
            if (!result.ok) {
              throw new Error(`修正 Agent 异常退出(${result.exit_code}): ${result.log.slice(-500)}`);
            }
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
            verified = await this.verifyCandidate(
              p4, repo, gitAttempts, null, investigation.planned_files,
            );
            opened = verified.opened;
            result.changed_files = [
              ...opened.map((item) => `project:${item.depot}`),
              ...verified.gitFiles,
            ];
            testOut = verified.summary;
            verificationPassed = verified.verified;
            this.store.updateJob(bug.id, { verification: verified });
            review = await this.reviewCandidate(
              reviewer!,
              p4,
              bug,
              investigation,
              verified.diff,
              verified.summary,
              additionalDirs,
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
        agent: backend,
        failure_reason: null,
        retry_evidence: null, // 成功则清空重试证据
        last_attempt_files: null,
        finished_at: nowStr(),
      });

      // ---- Tapd 回写 ----
      await this.notifyTapd(bug, state, cl, result, gitResults);
      this.store.addEvent(
        `完成（${state}）`
          + (cl ? `，changelist ${cl}` : "")
          + (gitResults.length ? `，Git 分支 ${gitResults.map((item) => item.result.branch).join(", ")}` : ""),
        "info",
        bug.id,
      );
    } catch (exc) {
      // 失败或人工中断可能留下未登记文件；下一次重新做一次完整基线扫描。
      if (activeRepo && activeRepo.preflight_reconcile === "once") {
        this.cleanP4Baselines.delete(activeRepo.path.replace(/\\/g, "/").toLowerCase());
      }
      let failure = exc;
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
      if (failure instanceof WorkspaceBlockedError) {
        const reason = failure.message.slice(0, 1000);
        this.store.updateJob(bug.id, {
          agent_state: "blocked_workspace",
          failure_reason: reason,
          finished_at: nowStr(),
        });
        this.store.addEvent(`工作区阻塞: ${reason}`, "warn", bug.id);
      } else if (failure instanceof InvestigationBlockedError
          || failure instanceof AgentInvestigationLimitError
          || failure instanceof AgentTimeoutError) {
        const reason = failure.message.slice(0, 1000);
        this.store.updateJob(bug.id, {
          agent_state: "needs_info",
          failure_reason: reason,
          finished_at: nowStr(),
        });
        this.store.addEvent(`Agent 未在执行预算内收敛，已停止自动重试: ${reason}`, "warn", bug.id);
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
        await this.handleFailure(bug, failure, p4, lastResult);
      }
    }
  }

  /** Tapd 回写：只发评论，绝不自动修改单子状态——状态由人工 review 并 submit 后自行处理。 */
  private async notifyTapd(
    bug: Bug,
    state: string,
    cl: number | null,
    result: AgentResult,
    gitResults: Array<{ name: string; result: GitFinalizeResult }> = [],
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
    const toRevert = files.filter((f) => inDefault.has(f));
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
   *  编号 changelist 是其它 bug 的成功产物，绝不能碰）。 */
  private async recordAttemptEnd(bugId: string, p4: P4Client | null): Promise<string[]> {
    let files: string[] = [];
    if (p4) {
      try {
        files = (await p4.opened("default"))
          .filter((o) => o.changelist === "default")
          .map((o) => o.depot);
      } catch {
        // p4 不可用则忽略，下次重试也无法清理
      }
    }
    this.store.updateJob(bugId, { last_attempt_files: dumps(files) });
    return files;
  }

  private async handleFailure(
    bug: Bug, exc: unknown, p4: P4Client | null, lastResult: AgentResult | null,
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
    };
    const evidence = [...this.retryEvidenceEntries(bug.id), entry].slice(-_MAX_EVIDENCE_ENTRIES);

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
    this.store.updateJob(bugId, {
      agent_state: "pending",
      attempts: 0,
      failure_reason: null,
      changelist: null,
      generated_description: null,
      files: null,
      manual_assets: null,
      finished_at: null,
      retry_evidence: null,
      admission_score: null,
      investigation: null,
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

  /** 把所有 failed 任务重置为待处理（web「重试全部失败」按钮）。返回重置数量。 */
  retryAllFailed(): number {
    const failed = this.store.listJobs("failed");
    for (const job of failed) {
      this.resetJobForRetry(String(job.bug_id));
    }
    if (failed.length) {
      this.store.addEvent(`人工重试全部失败任务（${failed.length} 个，已重置为待处理）`, "info");
    }
    return failed.length;
  }

  /** 清空任务状态与事件并从 Tapd 强制重新同步（人工质量反馈保留）。
   *  - 仅非运行状态可用（web 按钮已按控制态禁用；此处是后端的同一道闸，
   *    拦住绕过 UI 直调 API 的情况）
   *  - 本地 jobs/events 全删；Tapd 缓存作废后立即重拉最新列表
   *  - 拉到的每个 bug 落一条 pending job（排除 Tapd 侧终态），worker 从头按优先级处理
   *  返回 (清除的旧记录数, 新同步到的 bug 数)。p4 上已生成的 pending changelist
   *  是服务器侧对象，不受影响；但本地与之关联的 changelist 号/描述记录会一并清掉。 */
  async resyncFromTapd(): Promise<{ cleared: number; synced: number }> {
    if (this.state === "running") {
      throw new Error("运行中不可清除同步：请先停止自动处理（⏹ 关闭）");
    }
    if (this.currentBugId !== null) {
      throw new Error(`当前 bug ${this.currentBugId} 仍在停止中，请等待其退出后再清除同步`);
    }
    const cleared = this.store.deleteAllJobs();
    this.resetTapdClients(); // 清缓存 + 断开旧 MCP 连接，强制下一次真实拉取
    this.lastFetch = 0;
    this.lastFetchResult = null;

    const bugs = await this.fetchMyBugs(); // 缓存已作废，这里是真实重拉
    let synced = 0;
    for (const bug of bugs) {
      if (this.config.exclude_status.includes(bug.status)) continue;
      this.store.upsertJob(bug, { agent_state: "pending" });
      synced += 1;
    }
    this.store.addEvent(
      `人工清除并重新同步：清空 ${cleared} 条本地记录，从 Tapd 同步到 ${synced} 个 bug（已重置为待处理）`,
      "warn",
    );
    this.wake(); // 立即唤醒工作循环（若有正在 sleep 的轮询）
    return { cleared, synced };
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

  status(): Record<string, unknown> {
    return {
      control: this.store.getControl(),
      current_bug: this.currentBugId,
      jobs_total: this.store.jobCount(),
      queued: this.store.queuedCount(),
      counts: this.store.jobStateCounts(),
    };
  }
}

export { P4Error, TapdError };
