/** SQLite 状态库：控制态 / bug 任务 / 审计日志。
 *
 * 注意：bug_id 是 >2^53 的 TAPD 大整数，JS Number 无法精确表示。
 * 全程以 string 传递；打开 DB 时 safeIntegers:true 让超界 INTEGER 以 BigInt
 * 返回，再 String() 化。
 */

import Database from "better-sqlite3";
import path from "node:path";
import type { Bug } from "./models.js";
import { dumps } from "./models.js";

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
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(agent_state);
CREATE INDEX IF NOT EXISTS idx_events_bug ON events(bug_id);
`;

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
]);

export class StateStore {
  private db: Database.Database;

  constructor(dbPath = "tapd_agent.db") {
    const resolved = dbPath === ":memory:" ? dbPath : path.resolve(dbPath);
    this.db = new Database(resolved);
    // 所有整数结果以 BigInt 返回，避免大整数 bug_id / changelist 丢精度（构造选项 safeIntegers 类型缺失，用等价方法）
    this.db.defaultSafeIntegers(true);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(_SCHEMA);
    // 迁移：旧库补新增列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
    const cols = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    for (const col of ["model", "retry_evidence", "last_attempt_files"]) {
      if (!cols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO control(id, state, updated_at) VALUES (1, 'stopped', ?)")
      .run(nowStr());
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
      if (key === "files" || key === "manual_assets") {
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

  // ---------- events ----------
  addEvent(msg: string, level = "info", bugId?: string): void {
    this.db
      .prepare("INSERT INTO events(ts, level, bug_id, msg) VALUES (?,?,?,?)")
      .run(nowStr(), level, bugId ?? null, msg.slice(0, 2000));
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
