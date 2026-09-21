/** SQLite 状态库：控制态 / bug 任务 / 审计日志。
 *
 * 注意：bug_id 是 >2^53 的 TAPD 大整数，JS Number 无法精确表示。
 * 全程以 string 传递；打开 DB 时 safeIntegers:true 让超界 INTEGER 以 BigInt
 * 返回，再 String() 化。
 *
 * 只维护当前架构：DB 头部 user_version 是「当前 schema」的唯一标记；旧库既不迁移
 * 也不混写，读出旧标记后直接拒绝并要求使用新库文件（见 SCHEMA_VERSION）。
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { Bug } from "./models.js";
import { dumps } from "./models.js";
import { AttemptAudit } from "./attemptAudit.js";

const _SCHEMA = `
CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    bug_id INTEGER PRIMARY KEY,
    workspace_id TEXT,
    title TEXT,
    priority TEXT,
    priority_label TEXT,
    tapd_status TEXT,
    agent_state TEXT,
    changelist INTEGER,
    generated_description TEXT,
    files TEXT,
    manual_assets TEXT,
    failure_reason TEXT,
    agent TEXT,
    model TEXT,
    attempts INTEGER DEFAULT 0,
    retry_evidence TEXT,
    last_attempt_files TEXT,
    admission_score INTEGER,
    investigation TEXT,
    verification TEXT,
    review_findings TEXT,
    started_at TEXT,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    level TEXT,
    bug_id INTEGER,
    msg TEXT
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(agent_state);
CREATE INDEX IF NOT EXISTS idx_events_bug ON events(bug_id);
`;

/** 当前状态库 schema 版本，写入 DB 头部 user_version；非本版本一律拒绝。 */
export const SCHEMA_VERSION = 3;
/** 默认状态库文件：新架构从新文件开始采集，旧库保持原样不再读写。 */
export const DEFAULT_DB_PATH = "tapd_agent_v3.db";
/** 只存在于旧架构的表：出现即判定为旧库，即使 user_version 被改过也拒绝。 */
const _LEGACY_TABLES = new Set(["job_feedback", "legacy_job_snapshots"]);
/** 当前架构必需的任务列：缺失即拒绝，不做自动迁移。 */
const _REQUIRED_JOB_COLUMNS = [
  "model", "retry_evidence", "last_attempt_files", "admission_score",
  "investigation", "verification", "review_findings",
];

export type FeedbackOutcome =
  | "accepted_unchanged"
  | "accepted_modified"
  | "rejected_wrong_root_cause"
  | "rejected_wrong_location"
  | "rejected_regression"
  | "rejected_overchange"
  | "rejected_no_effect"
  | "reopened";

export interface JobFeedbackInput {
  outcome: FeedbackOutcome;
  reason: string;
  human_changed_lines: number | null;
  submitted_changelist: number | null;
  candidate_id: string;
  human_minutes?: number | null;
  modification_category?: string;
  final_patch_ref?: string;
}

export interface QualityMetrics {
  candidates: ReturnType<AttemptAudit["metrics"]>;
}

/** 全局 provider 冷却：跨进程持久化，避免重启后立刻继续把整批工单喂给不可用的 provider。
 *  只存放有界的冷却截止时间；到期自动恢复探测，不会永久停机；人工重试可提前解除。
 *  刻意复用 settings KV 而不是给 jobs 加列，也不改动 user_version——旧库（v3）必须继续可打开，
 *  否则历史误阻塞任务无法被恢复。 */
export interface ProviderCooldown {
  /** 冷却截止时间（epoch ms）。 */
  until_ms: number;
  /** transient | quota | auth（写入方决定，这里只存字符串以免与 agent.ts 循环依赖）。 */
  kind: string;
  reason: string;
  /** 连续 provider 失败次数，用于指数退避；成功或被人工解除后清零。 */
  failures: number;
}

const _PROVIDER_COOLDOWN_KEY = "provider_cooldown";
/** 显式解除冷却的 generation 计数：用于识别「本次尝试开始后人工已解除过冷却」。
 *  否则一次迟到的 provider 错误会在人工点「重试」之后又把冷却打开，用户点了重试却毫无反应。 */
const _PROVIDER_EPOCH_KEY = "provider_cooldown_epoch";

const _FEEDBACK_OUTCOMES = new Set<FeedbackOutcome>([
  "accepted_unchanged", "accepted_modified", "rejected_wrong_root_cause",
  "rejected_wrong_location", "rejected_regression", "rejected_overchange",
  "rejected_no_effect", "reopened",
]);

export function nowStr(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 DB 读出的 bug_id（Number 或 BigInt）统一转 string。 */
function idToString(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return String(v);
  return String(v ?? "");
}

/** 数值列（changelist/attempts）safeIntegers 下返回 BigInt，统一转 number/null。 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return Number(v);
}

const _UPDATE_ALLOWED = new Set([
  "title", "priority", "priority_label", "tapd_status", "agent_state",
  "changelist", "generated_description", "files", "manual_assets",
  "failure_reason", "agent", "model", "attempts", "started_at", "finished_at",
  "retry_evidence", "last_attempt_files",
  "admission_score", "investigation", "verification", "review_findings",
]);

export class StateStore {
  private db: Database.Database;
  readonly audit: AttemptAudit;

  constructor(dbPath = DEFAULT_DB_PATH) {
    const resolved = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
    // 拒绝旧库/坏库必须发生在任何写操作（WAL 切换、建表、版本标记）之前，否则会改写旧库文件。
    this.assertCurrentSchema(resolved);
    this.db = new Database(resolved);
    // 所有整数结果以 BigInt 返回，避免大整数 bug_id / changelist 丢精度（构造选项 safeIntegers 类型缺失，用等价方法）
    this.db.defaultSafeIntegers(true);
    // journal_mode 不能放在事务内；上面的检查已完成，此后才是本进程对库文件的写入。
    this.db.pragma("journal_mode = WAL");
    // 建表与版本标记同一事务：避免初始化中断后留下"有表但没版本标记"的半成品库。
    this.audit = this.db.transaction(() => {
      this.db.exec(_SCHEMA);
      const audit = new AttemptAudit(this.db);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return audit;
    })();
    this.db
      .prepare("INSERT OR IGNORE INTO control(id, state, updated_at) VALUES (1, 'stopped', ?)")
      .run(nowStr());
  }

  /** 只读探测：旧架构表、版本不符或列不齐都在这里拒绝。
   *  探测连接是 readonly，不切换 journal_mode、不建表、不写版本标记，也不把库升级成 WAL。 */
  private assertCurrentSchema(resolved: string): void {
    if (resolved === ":memory:" || !fs.existsSync(resolved)) return;
    const probe = new Database(resolved, { readonly: true });
    try {
      const tables = (probe.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all() as { name: string }[]).map((row) => row.name);
      const version = Number(probe.pragma("user_version", { simple: true }));
      const legacy = tables.filter((name) => _LEGACY_TABLES.has(name));
      if (legacy.length) {
        throw new Error(
          `检测到旧版状态库（${resolved}，含旧架构表 ${legacy.join(", ")}）；旧库保持原样不再使用，`
          + `开发阶段不自动迁移，请改用新库文件（默认 ${DEFAULT_DB_PATH}）`,
        );
      }
      if (tables.length && version !== SCHEMA_VERSION) {
        throw new Error(
          `状态库 schema 版本不匹配（${resolved}，期望 ${SCHEMA_VERSION}，实际 ${version}）；旧库保持原样不再使用，`
          + `开发阶段不自动迁移，请改用新库文件（默认 ${DEFAULT_DB_PATH}）`,
        );
      }
      if (tables.includes("jobs")) {
        const cols = (probe.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((column) => column.name);
        const missing = _REQUIRED_JOB_COLUMNS.filter((name) => !cols.includes(name));
        if (missing.length) {
          throw new Error(
            `状态库 schema 不匹配（${resolved}），缺少列: ${missing.join(", ")}；开发阶段不自动迁移，`
            + `旧库保持原样，请改用新库文件（默认 ${DEFAULT_DB_PATH}）`,
          );
        }
      }
    } finally {
      probe.close();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- control ----------
  getControl(): string {
    const row = this.db.prepare("SELECT state FROM control WHERE id=1").get() as
      | { state: string }
      | undefined;
    return row?.state ?? "stopped";
  }

  setControl(state: string): string {
    this.db
      .prepare("UPDATE control SET state=?, updated_at=? WHERE id=1")
      .run(state, nowStr());
    return state;
  }

  // ---------- settings / provider 全局冷却 ----------
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(key, value, nowStr());
  }

  /** 读取冷却记录（即使已过期也返回，保留 failures 计数连续性）。损坏/缺失返回 null。 */
  peekProviderCooldown(): ProviderCooldown | null {
    const raw = this.getSetting(_PROVIDER_COOLDOWN_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ProviderCooldown>;
      const until = Number(parsed.until_ms);
      if (!Number.isFinite(until) || until <= 0) return null;
      const failures = Number(parsed.failures);
      return {
        until_ms: until,
        kind: String(parsed.kind ?? "transient"),
        reason: String(parsed.reason ?? ""),
        failures: Number.isFinite(failures) && failures > 0 ? failures : 0,
      };
    } catch {
      return null;
    }
  }

  /** 仍在冷却期内的记录；已过期返回 null（记录保留以便失败计数继续增长）。 */
  activeProviderCooldown(now = Date.now()): ProviderCooldown | null {
    const cooldown = this.peekProviderCooldown();
    return cooldown && cooldown.until_ms > now ? cooldown : null;
  }

  setProviderCooldown(cooldown: ProviderCooldown): void {
    this.setSetting(_PROVIDER_COOLDOWN_KEY, JSON.stringify(cooldown));
  }

  /** 清空冷却（含 failures 计数）。返回是否确实清掉了记录。
   *  同时推进 generation：调用方是「人工明确要求现在重试」，迟到回来的 provider 错误
   *  不得在这次解除之后又把冷却重新打开。 */
  clearProviderCooldown(): boolean {
    const existed = this.peekProviderCooldown() !== null;
    this.setSetting(_PROVIDER_COOLDOWN_KEY, null);
    this.setSetting(_PROVIDER_EPOCH_KEY, String(this.providerCooldownEpoch() + 1));
    return existed;
  }

  /** 当前 generation：尝试开始时取一次，写冷却前比对，识别期间是否发生过人工解除。 */
  providerCooldownEpoch(): number {
    const raw = this.getSetting(_PROVIDER_EPOCH_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // ---------- jobs ----------
  upsertJob(bug: Bug, fields?: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO jobs (bug_id, workspace_id, title, priority, priority_label,
                           tapd_status, agent_state, started_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(bug_id) DO UPDATE SET
           title=excluded.title,
           priority=excluded.priority,
           priority_label=excluded.priority_label,
           tapd_status=excluded.tapd_status,
           agent_state=excluded.agent_state`,
      )
      .run(
        bug.id, bug.workspace_id, bug.title, bug.priority, bug.priority_label,
        bug.status, "pending", nowStr(),
      );
    if (fields && Object.keys(fields).length) {
      this.updateJob(bug.id, fields);
    }
  }

  updateJob(bugId: string, fields: Record<string, unknown>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (!_UPDATE_ALLOWED.has(key)) continue;
      let v = value;
      if (["files", "manual_assets", "investigation", "verification", "review_findings"].includes(key)) {
        // null/undefined 存真正的 NULL；数组/对象才 dumps 成 JSON 字符串。
        // 注意：dumps(null) 会得到字面字符串 "null"，前端 JSON.parse 后是 null，
        // 取 .length 会崩——所以 null 必须原样入库，不能过 dumps。
        v = v === null || v === undefined ? null : typeof v === "string" ? v : dumps(v);
      }
      sets.push(`${key}=?`);
      vals.push(v);
    }
    if (!sets.length) return;
    vals.push(bugId);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE bug_id=?`).run(...vals);
  }

  getJob(bugId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE bug_id=?").get(bugId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    const out: Record<string, unknown> = { ...row };
    out.bug_id = idToString(row.bug_id);
    if (out.changelist !== undefined) out.changelist = numOrNull(out.changelist);
    if (out.attempts !== undefined) out.attempts = Number(out.attempts);
    return out;
  }

  listJobs(agentState?: string, search?: string): Record<string, unknown>[] {
    let sql = "SELECT * FROM jobs";
    const where: string[] = [];
    const params: unknown[] = [];
    if (agentState && agentState !== "all") {
      where.push("agent_state=?");
      params.push(agentState);
    }
    if (search) {
      where.push("(title LIKE ? OR CAST(bug_id AS TEXT) LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY started_at DESC, bug_id DESC";
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => {
      const out: Record<string, unknown> = { ...r, bug_id: idToString(r.bug_id) };
      if (out.changelist !== undefined) out.changelist = numOrNull(out.changelist);
      if (out.attempts !== undefined) out.attempts = Number(out.attempts);
      return out;
    });
  }

  jobStateCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT agent_state, COUNT(*) AS n FROM jobs GROUP BY agent_state")
      .all() as { agent_state: string | null; n: number | bigint }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.agent_state)] = Number(r.n);
    return out;
  }

  jobCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
    return Number(row.n);
  }

  queuedCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent_state IN ('pending','in_progress')")
      .get() as { n: number };
    return Number(row.n);
  }

  recordFeedback(bugId: string, input: JobFeedbackInput): void {
    if (!_FEEDBACK_OUTCOMES.has(input.outcome)) {
      throw new Error(`未知反馈结果: ${String(input.outcome)}`);
    }
    if (!this.getJob(bugId)) throw new Error(`未找到 bug: ${bugId}`);
    const attempts = this.audit.attempts(bugId);
    if (!input.candidate_id?.trim()) {
      throw new Error("必须选择具体候选版本后记录反馈；未产出补丁的尝试不能记为候选接受");
    }
    const candidates = this.audit.candidates(bugId);
    const target = candidates.find(c => c.candidate_id === input.candidate_id);
    if (!target) throw new Error("候选不存在或不属于该 Bug，请重新选择候选版本");
    this.db.transaction(() => {
      this.audit.recordFeedback(bugId, input);
      // A decision on an older candidate must not overwrite a newer attempt's live state.
      const latest = attempts.at(-1);
      const isCurrent = target.attempt_id === latest?.attempt_id
        && latest.events.some(e => e.kind === "finished")
        && candidates.at(-1)?.candidate_id === target.candidate_id;
      const agentState = input.outcome === "accepted_unchanged"
        ? "accepted"
        : input.outcome === "accepted_modified"
          ? "accepted_modified"
          : input.outcome === "reopened" ? "reopened" : "rejected";
      if (isCurrent) this.updateJob(bugId, { agent_state: agentState, finished_at: nowStr() });
    })();
    this.addEvent(`人工反馈: ${input.outcome}${input.reason ? `（${input.reason}）` : ""}`, "info", bugId);
  }

  /** 现役口径：全部指标按具体候选版本统计（见 AttemptAudit.metrics）。 */
  qualityMetrics(): QualityMetrics {
    return { candidates: this.audit.metrics() };
  }

  /** 清空全部 job 记录与事件（web「清除并重新同步」用）。
   *  控制态（control 表）保留；changelist 等历史一并删除——p4 上已生成的
   *  pending changelist 不受影响（那是 p4 服务器侧的对象）。候选与人工反馈是长期质量标签，保留。 */
  deleteAllJobs(): number {
    const n = this.jobCount();
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM jobs").run();
      this.db.prepare("DELETE FROM events").run();
    });
    tx();
    return n;
  }

  /** 重新同步时保留已经产生候选/人工结论的任务，避免页面统计和 changelist 关联被清空。 */
  deleteRetryableJobs(preservedStates: string[]): { cleared: number; preserved: number } {
    const states = [...new Set(preservedStates.filter(Boolean))];
    if (!states.length) return { cleared: this.deleteAllJobs(), preserved: 0 };
    const placeholders = states.map(() => "?").join(",");
    const preserved = Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE agent_state IN (${placeholders})`,
    ).get(...states) as { n: number | bigint }).n);
    const total = this.jobCount();
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM events WHERE bug_id IS NULL OR bug_id IN (`
          + `SELECT bug_id FROM jobs WHERE agent_state NOT IN (${placeholders}))`,
      ).run(...states);
      this.db.prepare(`DELETE FROM jobs WHERE agent_state NOT IN (${placeholders})`).run(...states);
    });
    tx();
    return { cleared: total - preserved, preserved };
  }

  // ---------- events ----------
  addEvent(msg: string, level = "info", bugId?: string): void {
    const ts = nowStr();
    this.db
      .prepare("INSERT INTO events(ts, level, bug_id, msg) VALUES (?,?,?,?)")
      .run(ts, level, bugId ?? null, msg.slice(0, 2000));

    // Web 事件也是服务端最有价值的运行日志。同步输出到控制台，避免后台任务
    // 在 P4 / Git / Agent 等长耗时步骤中表现成黑盒。仅控制台侧做敏感信息脱敏，
    // 数据库仍保留原事件文本供管理台展示和问题追溯。
    const safe = msg
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|api_key|access_token|password|passwd|secret)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/\b(token|api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
    const scope = bugId ? ` [bug:${bugId}]` : "";
    const line = `[${ts}] [${level.toUpperCase()}]${scope} ${safe}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  listEvents(bugId?: string, limit = 200): Record<string, unknown>[] {
    let sql: string;
    const params: unknown[] = [];
    if (bugId !== undefined) {
      sql = "SELECT * FROM events WHERE bug_id=? ORDER BY id DESC LIMIT ?";
      params.push(bugId, limit);
    } else {
      sql = "SELECT * FROM events ORDER BY id DESC LIMIT ?";
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, bug_id: idToString(r.bug_id) }));
  }
}
