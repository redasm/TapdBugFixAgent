/** Append-only repair evidence. Historical labels are never guessed onto new candidates. */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { dumps } from "./models.js";

export const evidenceHash = (value: unknown): string => createHash("sha256").update(
  typeof value === "string" ? value : dumps(value),
).digest("hex");

export const hasPatchEvidence = (diff: string): boolean => diff.split(/\r?\n/).some(line =>
  /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line))
  || /(?:Binary files .* differ|GIT binary patch|\(\.\.\. files differ \.\.\.\))/.test(diff);

export interface AttemptInput {
  bug_id: string;
  workspace_id: string;
  input: unknown;
  metadata: Record<string, unknown>;
  cohort?: string;
}

export interface CandidateInput {
  diff: string;
  files: string[];
  delivery: "complete" | "partial";
  evidence: Record<string, unknown>;
}

export interface CandidateFeedbackInput {
  candidate_id: string;
  outcome: string;
  reason: string;
  human_changed_lines: number | null;
  human_minutes?: number | null;
  modification_category?: string;
  final_patch_ref?: string;
  submitted_changelist: number | null;
}

export interface RepairAttempt {
  attempt_id: string;
  bug_id: string;
  workspace_id: string;
  cohort: string;
  started_at: string;
  input_hash: string;
  input: unknown;
  metadata: Record<string, unknown>;
  events: Array<{ kind: string; created_at: string; payload: Record<string, unknown> }>;
}

export interface RepairCandidate extends CandidateInput {
  candidate_id: string;
  attempt_id: string;
  bug_id: string;
  created_at: string;
  diff_hash: string;
}

export interface CandidateFeedback extends CandidateFeedbackInput {
  feedback_id: number;
  bug_id: string;
  created_at: string;
}

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const ratio = (a: number, b: number): number | null => b ? a / b : null;
const accepted = (outcome: string): boolean => ["accepted_unchanged", "accepted_modified"].includes(outcome);

/** 审计里**真正调用过**的一次 role/model 组合（来源：agent_input 事件）。 */
export interface ActualModelUse {
  /** 调用时标注的角色；null = 未标注角色的历史调用。 */
  role: string | null;
  /** 该次调用实际传给 pi 的模型；空串 = 未指定（pi 用自带默认）。 */
  model: string;
  /** 同一 role+model 的调用次数。 */
  calls: number;
}

/** 从审计事件里提取「实际调用过的 role/model」——只认 agent_input（每次模型调用在 spawn 之前必落一条），
 *  按首次出现顺序去重并统计调用次数。它回答的是「这次任务真的用了哪些模型」，
 *  与 metadata.default_model / job.model（只是「没配角色模型时的回退值」）是两个口径，
 *  因此展示时绝不能用后者冒充前者。 */
export function actualModelUses(attempts: RepairAttempt[]): ActualModelUse[] {
  const out: ActualModelUse[] = [];
  const seen = new Map<string, number>();
  for (const attempt of attempts) {
    for (const event of attempt.events) {
      if (event.kind !== "agent" || event.payload?.kind !== "agent_input") continue;
      const role = typeof event.payload.role === "string" && event.payload.role ? event.payload.role : null;
      const model = String(event.payload.model ?? "");
      const key = `${role ?? ""}\u0000${model}`;
      const at = seen.get(key);
      if (at === undefined) {
        seen.set(key, out.length);
        out.push({ role, model, calls: 1 });
      } else {
        out[at].calls += 1;
      }
    }
  }
  return out;
}

export class AttemptAudit {
  constructor(private readonly db: Database.Database) {
    // Separate versioning from the older jobs schema. DDL and version update are atomic.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS repair_attempts(
          attempt_id TEXT PRIMARY KEY, bug_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
          cohort TEXT NOT NULL, started_at TEXT NOT NULL, input_hash TEXT NOT NULL,
          input_json TEXT NOT NULL, metadata_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS repair_attempt_events(
          event_id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_finished ON repair_attempt_events(attempt_id)
          WHERE kind='finished';
        CREATE INDEX IF NOT EXISTS idx_attempt_bug ON repair_attempts(bug_id, started_at);
        CREATE INDEX IF NOT EXISTS idx_attempt_event ON repair_attempt_events(attempt_id,event_id);
        CREATE TABLE IF NOT EXISTS repair_candidates(
          candidate_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, bug_id TEXT NOT NULL,
          created_at TEXT NOT NULL, diff_hash TEXT NOT NULL, diff TEXT NOT NULL,
          files_json TEXT NOT NULL, delivery TEXT NOT NULL, evidence_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS candidate_feedback(
          feedback_id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_id TEXT NOT NULL,
          bug_id TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL,
          human_changed_lines INTEGER, human_minutes REAL, modification_category TEXT,
          final_patch_ref TEXT, submitted_changelist INTEGER, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_candidate_attempt ON repair_candidates(attempt_id);
        CREATE INDEX IF NOT EXISTS idx_candidate_feedback ON candidate_feedback(candidate_id,feedback_id);
        CREATE TABLE IF NOT EXISTS cohort_inputs(
          cohort TEXT NOT NULL, workspace_id TEXT NOT NULL, bug_id TEXT NOT NULL,
          enrolled_at TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL,
          PRIMARY KEY(cohort,workspace_id,bug_id)
        );
      `);
      db.prepare("INSERT OR IGNORE INTO audit_schema_versions VALUES (1,?)").run(new Date().toISOString());
    })();
  }

  begin(input: AttemptInput): string {
    const id = randomUUID();
    const at = new Date().toISOString();
    this.db.transaction(() => {
      this.enroll(input);
      for (const prior of this.attempts(input.bug_id).filter(a => !a.events.some(e => e.kind === "finished"))) {
        this.event(prior.attempt_id, "finished", { state: "interrupted", failure: "新尝试开始时发现前次缺少结束记录；结果未知" });
      }
      this.db.prepare("INSERT INTO repair_attempts VALUES (?,?,?,?,?,?,?,?)").run(
        id, input.bug_id, input.workspace_id, input.cohort || "production-v1", at,
        evidenceHash(input.input), dumps(input.input), dumps(input.metadata),
      );
    })();
    return id;
  }

  enroll(input: AttemptInput): void {
    this.db.prepare("INSERT OR IGNORE INTO cohort_inputs VALUES (?,?,?,?,?,?)").run(
      input.cohort || "production-v1", input.workspace_id, input.bug_id, new Date().toISOString(), evidenceHash(input.input), dumps(input.input));
  }

  event(attemptId: string, kind: string, payload: Record<string, unknown>): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM repair_attempts WHERE attempt_id=?").get(attemptId)) {
        throw new Error("未找到修复尝试");
      }
      if (this.db.prepare("SELECT 1 FROM repair_attempt_events WHERE attempt_id=? AND kind='finished'").get(attemptId)) {
        throw new Error("修复尝试已结束，不能追加执行记录");
      }
      this.db.prepare("INSERT INTO repair_attempt_events(attempt_id,kind,created_at,payload_json) VALUES (?,?,?,?)")
        .run(attemptId, kind, new Date().toISOString(), dumps(payload));
    })();
  }

  candidate(attemptId: string, input: CandidateInput): string {
    // Text headers / opened-file lists are not a patch. Binary evidence must be explicit.
    if (!input.files.length || !hasPatchEvidence(input.diff)) throw new Error("候选缺少真实非空补丁");
    if (!["complete", "partial"].includes(input.delivery)) throw new Error("未知交付状态");
    const attempt = this.db.prepare("SELECT bug_id FROM repair_attempts WHERE attempt_id=?").get(attemptId) as { bug_id: string } | undefined;
    if (!attempt) throw new Error("未找到修复尝试");
    if (this.db.prepare("SELECT 1 FROM repair_attempt_events WHERE attempt_id=? AND kind='finished'").get(attemptId)) {
      throw new Error("修复尝试已结束");
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO repair_candidates VALUES (?,?,?,?,?,?,?,?,?)").run(
      id, attemptId, attempt.bug_id, new Date().toISOString(), evidenceHash(input.diff), input.diff,
      dumps(input.files), input.delivery, dumps(input.evidence),
    );
    return id;
  }

  candidates(bugId?: string): RepairCandidate[] {
    const rows = this.db.prepare(`SELECT * FROM repair_candidates ${bugId ? "WHERE bug_id=?" : ""} ORDER BY rowid`)
      .all(...(bugId ? [bugId] : [])) as Record<string, unknown>[];
    return rows.map(row => ({
      candidate_id: String(row.candidate_id), attempt_id: String(row.attempt_id), bug_id: String(row.bug_id),
      created_at: String(row.created_at), diff_hash: String(row.diff_hash), diff: String(row.diff),
      files: parse<string[]>(row.files_json), delivery: row.delivery as CandidateInput["delivery"],
      evidence: parse<Record<string, unknown>>(row.evidence_json),
    }));
  }

  attempts(bugId?: string): RepairAttempt[] {
    const rows = this.db.prepare(`SELECT * FROM repair_attempts ${bugId ? "WHERE bug_id=?" : ""} ORDER BY rowid`)
      .all(...(bugId ? [bugId] : [])) as Record<string, unknown>[];
    return rows.map(row => ({
      attempt_id: String(row.attempt_id), bug_id: String(row.bug_id), workspace_id: String(row.workspace_id),
      cohort: String(row.cohort), started_at: String(row.started_at), input_hash: String(row.input_hash),
      input: parse(row.input_json), metadata: parse(row.metadata_json),
      events: (this.db.prepare("SELECT kind,created_at,payload_json FROM repair_attempt_events WHERE attempt_id=? ORDER BY event_id")
        .all(row.attempt_id) as Record<string, unknown>[]).map(event => ({
          kind: String(event.kind), created_at: String(event.created_at), payload: parse(event.payload_json),
        })),
    }));
  }

  feedback(bugId?: string): CandidateFeedback[] {
    return (this.db.prepare(`SELECT * FROM candidate_feedback ${bugId ? "WHERE bug_id=?" : ""} ORDER BY feedback_id`)
      .all(...(bugId ? [bugId] : [])) as Record<string, unknown>[]).map(row => ({
        ...row, feedback_id: Number(row.feedback_id),
        human_changed_lines: row.human_changed_lines === null ? null : Number(row.human_changed_lines),
        human_minutes: row.human_minutes === null ? null : Number(row.human_minutes),
        submitted_changelist: row.submitted_changelist === null ? null : Number(row.submitted_changelist),
      })) as unknown as CandidateFeedback[];
  }

  recordFeedback(bugId: string, input: CandidateFeedbackInput): void {
    if (!["accepted_unchanged", "accepted_modified", "rejected_wrong_root_cause", "rejected_wrong_location", "rejected_regression", "rejected_overchange", "rejected_no_effect", "reopened"].includes(input.outcome)) throw new Error("未知反馈结果");
    const candidate = this.candidates(bugId).find(item => item.candidate_id === input.candidate_id);
    if (!candidate) throw new Error("候选不存在或不属于该 Bug，请重新选择候选版本");
    for (const value of [input.human_changed_lines, input.human_minutes, input.submitted_changelist]) {
      if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error("人工修改数量、耗时或提交编号无效");
    }
    for (const value of [input.human_changed_lines, input.submitted_changelist]) {
      if (value != null && !Number.isSafeInteger(value)) throw new Error("行数与提交编号必须是整数");
    }
    if (input.outcome === "reopened") {
      const latest = this.feedback(bugId).filter(item => item.candidate_id === input.candidate_id).at(-1);
      if (!latest || (!accepted(latest.outcome) && latest.outcome !== "reopened")) {
        throw new Error("只能对已经接受的同一候选记录重开");
      }
    }
    this.db.prepare(`INSERT INTO candidate_feedback(candidate_id,bug_id,outcome,reason,human_changed_lines,
      human_minutes,modification_category,final_patch_ref,submitted_changelist,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(input.candidate_id, bugId, input.outcome, input.reason.slice(0, 2000), input.human_changed_lines,
        input.human_minutes ?? null, input.modification_category || "", input.final_patch_ref || "",
        input.submitted_changelist, new Date().toISOString());
  }

  metrics(options: { cohort?: string; followup_days?: number; now?: Date } = {}) {
    const attempts = this.attempts().filter(a => !options.cohort || a.cohort === options.cohort);
    const ids = new Set(attempts.map(a => a.attempt_id));
    const candidates = this.candidates().filter(c => ids.has(c.attempt_id));
    const complete = candidates.filter(c => c.delivery === "complete");
    const feedback = this.feedback();
    const decision = (id: string) => feedback.filter(f => f.candidate_id === id && f.outcome !== "reopened").at(-1);
    const reviewed = complete.filter(c => decision(c.candidate_id));
    const acceptedCandidates = reviewed.filter(c => accepted(decision(c.candidate_id)!.outcome));
    const unchanged = reviewed.filter(c => decision(c.candidate_id)!.outcome === "accepted_unchanged");
    const enrolled = this.db.prepare(`SELECT cohort,workspace_id,bug_id FROM cohort_inputs ${options.cohort ? "WHERE cohort=?" : ""}`).all(...(options.cohort ? [options.cohort] : [])) as Array<{ cohort: string; workspace_id: string; bug_id: string }>;
    const inputs = new Set([...enrolled, ...attempts].map(a => `${a.cohort}:${a.workspace_id}:${a.bug_id}`));
    const inputKey = (c: RepairCandidate) => {
      const a = attempts.find(a => a.attempt_id === c.attempt_id)!;
      return `${a.cohort}:${a.workspace_id}:${a.bug_id}`;
    };
    const now = (options.now || new Date()).getTime();
    const days = options.followup_days ?? 14;
    const matured = acceptedCandidates.filter(c => now - Date.parse(decision(c.candidate_id)!.created_at) >= days * 86400000);
    const reopened = (c: RepairCandidate, withinDays?: number) => feedback.some(f =>
      f.candidate_id === c.candidate_id && f.outcome === "reopened"
      && Date.parse(f.created_at) >= Date.parse(decision(c.candidate_id)!.created_at)
      && (withinDays === undefined || Date.parse(f.created_at) - Date.parse(decision(c.candidate_id)!.created_at) <= withinDays * 86400000));
    const effective = acceptedCandidates.filter(c => !reopened(c));
    const measurements = acceptedCandidates.map(c => decision(c.candidate_id)!);
    const minutes = measurements.filter(f => f.human_minutes != null);
    const finished = attempts.flatMap(a => a.events.filter(e => e.kind === "finished").map(e => ({ a, e })));
    const usages = attempts.flatMap(a => a.events.filter(e => e.kind === "agent" && e.payload.kind === "agent_usage").map(e => e.payload));
    const calls = usages.reduce((s,u) => s+Number(u.tool_calls || 0),0);
    const inputsUsed = attempts.flatMap(a=>a.events.filter(e=>e.kind==="agent" && e.payload.kind==="agent_input"));
    return {
      schema_version: 1, cohort: options.cohort || "all", inputs: inputs.size, attempts: attempts.length,
      finished_attempts: finished.length, complete_candidates: complete.length,
      partial_candidates: candidates.length - complete.length, reviewed: reviewed.length,
      accepted_unchanged: unchanged.length, accepted_modified: acceptedCandidates.length - unchanged.length,
      rejected: reviewed.length - acceptedCandidates.length,
      candidate_precision: ratio(acceptedCandidates.length, reviewed.length),
      unchanged_acceptance_rate: ratio(unchanged.length, reviewed.length),
      candidate_coverage: ratio(new Set(complete.map(inputKey)).size, inputs.size),
      feedback_coverage: ratio(reviewed.length, complete.length),
      end_to_end_effective_rate: ratio(new Set(effective.map(inputKey)).size, inputs.size),
      followup_days: days, followup_matured: matured.length,
      sustained_fix_rate: ratio(matured.filter(c => !reopened(c, days)).length, matured.length),
      reopened_candidates: acceptedCandidates.filter(c => reopened(c)).length,
      human_minutes_samples: minutes.length,
      mean_human_minutes: ratio(minutes.reduce((sum, f) => sum + f.human_minutes!, 0), minutes.length),
      modification_lines_unknown: measurements.filter(f => f.human_changed_lines === null).length,
      mean_attempt_seconds: ratio(finished.reduce((sum, { a, e }) => sum + Math.max(0, Date.parse(e.created_at) - Date.parse(a.started_at)) / 1000, 0), finished.length),
      tool_calls: calls, tool_errors: usages.reduce((s,u) => s+Number(u.tool_errors || 0),0),
      tool_error_rate: ratio(usages.reduce((s,u) => s+Number(u.tool_errors || 0),0),calls),
      model_cost: usages.length>0 && usages.length===inputsUsed.length && usages.every(u=>u.reported_model_cost!=null)
        ? usages.reduce((s,u)=>s+Number(u.reported_model_cost),0) : null,
    };
  }
}
