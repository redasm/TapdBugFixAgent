import { evidenceHash } from "./attemptAudit.js";

export interface DatasetCase {
  bug_id: string; group: string; split: "development" | "holdout";
  input_hash: string; captured_at: string;
  replay: { status: "label_only" | "ready"; source_revision?: string; resource_revision?: string; acceptance_suite_hash?: string };
}
export interface EvaluationDataset { version: 1; frozen_at: string; cases: DatasetCase[] }
export interface PairedTrial {
  bug_id: string; group: string; run: string; repetition: number;
  input_hash: string; source_revision: string; resource_revision: string; acceptance_suite_hash: string;
  budget_hash: string; model: string; prompt_version: string; workspace_id: string;
  attempt_id: string; candidate_id: string | null; human_outcome: string | null;
  seconds: number; cost: number | null; tool_calls: number; tool_errors: number;
  retrieved_bug_ids: string[]; retrieved_groups: string[];
}

export function validateEvaluationDataset(dataset: EvaluationDataset): void {
  if (!dataset || dataset.version !== 1 || !Number.isFinite(Date.parse(dataset.frozen_at))) throw new Error("无效数据集版本或冻结时间");
  if (!Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error("评测数据集为空或 cases 不是数组");
  const ids = new Set<string>(), groups = new Map<string, string>();
  for (const c of dataset.cases) {
    if (!c || !c.bug_id || !c.group || !c.input_hash || ids.has(c.bug_id)) throw new Error("缺陷身份缺失或重复");
    if (!["development", "holdout"].includes(c.split) || !["label_only", "ready"].includes(c.replay?.status)) throw new Error("无效数据集分组或重放状态");
    ids.add(c.bug_id);
    if (groups.has(c.group) && groups.get(c.group) !== c.split) throw new Error("同源缺陷跨开发集/留出集，存在答案泄漏");
    groups.set(c.group, c.split);
    if (!Number.isFinite(Date.parse(c.captured_at)) || (c.split === "holdout" && Date.parse(c.captured_at) <= Date.parse(dataset.frozen_at))) throw new Error("留出集必须来自冻结时间之后的新工单");
    if (c.replay.status === "ready" && (!c.replay.source_revision || !c.replay.resource_revision || !c.replay.acceptance_suite_hash)) throw new Error("缺少历史源码、资源或验收测试版本，只能做标签分析");
  }
}

/** Checks recorded isolation identities; does not create or certify a P4 replay environment. */
export function comparePairedTrials(dataset: EvaluationDataset, trials: PairedTrial[]) {
  validateEvaluationDataset(dataset);
  const byId = new Map(dataset.cases.map(c => [c.bug_id, c]));
  const pairs = new Map<string, string>(), runs = new Map<string, Set<string>>(), workspaces = new Set<string>();
  for (const t of trials) {
    const c = byId.get(t.bug_id);
    if (!c || c.replay.status !== "ready") throw new Error("标签案例不能伪称历史重放");
    if (t.group !== c.group || t.input_hash !== c.input_hash || t.source_revision !== c.replay.source_revision
      || t.resource_revision !== c.replay.resource_revision || t.acceptance_suite_hash !== c.replay.acceptance_suite_hash) throw new Error("重放输入/版本与冻结数据集不符");
    if (t.retrieved_bug_ids.includes(t.bug_id) || t.retrieved_groups.includes(t.group)) throw new Error("评测检索包含本题或同源答案");
    if (!t.workspace_id || workspaces.has(t.workspace_id)) throw new Error("评测试验必须使用独立工作区身份");
    workspaces.add(t.workspace_id);
    if (!Number.isInteger(t.repetition) || t.repetition < 1 || !t.attempt_id || !t.model || !t.prompt_version || !t.budget_hash
      || [t.seconds,t.tool_calls,t.tool_errors].some(n => !Number.isFinite(n) || n < 0)
      || (t.cost !== null && (!Number.isFinite(t.cost) || t.cost < 0))) throw new Error("试验身份或实测成本缺失");
    const key = `${t.bug_id}:${t.repetition}`;
    const identity = evidenceHash([t.input_hash,t.source_revision,t.resource_revision,t.acceptance_suite_hash,t.budget_hash]);
    if (pairs.has(key) && pairs.get(key) !== identity) throw new Error("对照组初始版本或预算不一致");
    pairs.set(key,identity);
    const seen = runs.get(t.run) || new Set<string>();
    if (seen.has(key)) throw new Error("重复试验结果，不能挑选最好一次");
    seen.add(key); runs.set(t.run,seen);
  }
  return [...runs].map(([run, keys]) => {
    if (keys.size !== pairs.size) throw new Error("对照组缺少配对试验");
    const rows = trials.filter(t => t.run === run), total = rows.length;
    const candidates = rows.filter(t => t.candidate_id), reviewed = candidates.filter(t => t.human_outcome);
    const accepted = reviewed.filter(t => ["accepted_unchanged","accepted_modified"].includes(t.human_outcome!));
    const rate = (n: number,d: number) => d ? n/d : null;
    return { run, trials: total, candidate_coverage: rate(candidates.length,total), feedback_coverage: rate(reviewed.length,candidates.length),
      top1_acceptance: rate(accepted.length,total), candidate_precision: rate(accepted.length,reviewed.length),
      unchanged_acceptance: rate(reviewed.filter(t => t.human_outcome === "accepted_unchanged").length,total),
      mean_seconds: rate(rows.reduce((s,t) => s+t.seconds,0),total), cost: rows.some(t=>t.cost===null) ? null : rows.reduce((s,t)=>s+t.cost!,0),
      tool_error_rate: rate(rows.reduce((s,t)=>s+t.tool_errors,0),rows.reduce((s,t)=>s+t.tool_calls,0)) };
  });
}
