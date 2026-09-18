import { describe, it, expect } from "vitest";
import { comparePairedTrials, validateEvaluationDataset, type EvaluationDataset, type PairedTrial } from "../src/evaluationDataset.js";
import { validateAmendedScope, scopeAmendment } from "../src/scopeAmendment.js";
import { parseInvestigation } from "../src/repairWorkflow.js";
import { contractFixture } from "./contractFixture.js";
import { parseRepairContract } from "../src/repairContract.js";
import { parseReviewResult } from "../src/review.js";
import { StateStore } from "../src/state.js";

const dataset: EvaluationDataset = { version: 1, frozen_at: "2026-09-18T00:00:00Z", cases: [{
  bug_id: "1", group: "map", split: "holdout", input_hash: "input", captured_at: "2026-09-19T00:00:00Z",
  replay: { status: "ready", source_revision: "source", resource_revision: "resource", acceptance_suite_hash: "suite" },
}] };
const trial: PairedTrial = { bug_id: "1", group: "map", run: "A", repetition: 1, input_hash: "input", source_revision: "source", resource_revision: "resource", acceptance_suite_hash: "suite", budget_hash: "budget", model: "model", prompt_version: "p1", workspace_id: "isolated-A", attempt_id: "attempt", candidate_id: "candidate", human_outcome: "accepted_unchanged", seconds: 5, cost: null, tool_calls: 2, tool_errors: 0, retrieved_bug_ids: [], retrieved_groups: [] };

describe("accuracy evaluation guards", () => {
  it("rejects leaked groups, same-answer retrieval and label-only replays", () => {
    expect(() => validateEvaluationDataset({ ...dataset, cases: [...dataset.cases, { ...dataset.cases[0], bug_id: "2", split: "development" }] })).toThrow("泄漏");
    expect(() => comparePairedTrials(dataset, [{ ...trial, retrieved_groups: ["map"] }])).toThrow("答案");
    expect(() => comparePairedTrials({ ...dataset, cases: [{ ...dataset.cases[0], replay: { status: "label_only" } }] }, [trial])).toThrow("标签");
  });
  it("counts no-candidate inputs and preserves unknown costs in paired comparisons", () => {
    const result = comparePairedTrials(dataset, [trial, { ...trial, run: "B", workspace_id: "isolated-B", candidate_id: null, human_outcome: null }]);
    expect(result[0]).toMatchObject({ top1_acceptance: 1, cost: null });
    expect(result[1]).toMatchObject({ top1_acceptance: 0, candidate_coverage: 0, candidate_precision: null });
    expect(() => comparePairedTrials(dataset, [trial, { ...trial, run: "B", workspace_id: "isolated-B", budget_hash: "different" }])).toThrow("预算");
  });
  it("rejects duplicate selections and missing paired trials", () => {
    expect(() => comparePairedTrials(dataset, [trial, { ...trial, candidate_id: "alternative", workspace_id: "another" }])).toThrow("重复试验");
    expect(() => comparePairedTrials(dataset, [trial, { ...trial, run: "B", repetition: 2, workspace_id: "B" }])).toThrow("缺少配对");
  });
  it("keeps enrolled abstentions in the denominator and closes interrupted attempts", () => {
    const store = new StateStore(":memory:");
    const input = { bug_id: "1", workspace_id: "w", input: {}, metadata: {} };
    store.audit.enroll({ ...input, bug_id: "2" });
    const first = store.audit.begin(input);
    store.audit.begin(input);
    expect(store.audit.metrics()).toMatchObject({ inputs: 2, attempts: 2, candidate_coverage: 0 });
    expect(store.audit.attempts()[0].events.at(-1)?.payload.state).toBe("interrupted");
    expect(() => store.audit.event(first,"patch",{})).toThrow("已结束");
    store.close();
  });
});

describe("contract and scope boundaries", () => {
  const investigation = parseInvestigation(JSON.stringify({ root_cause: "共享方法缺失", evidence: ["[观察] a.ts:foo 未使用公共方法","[推断] 提取可避免重复"], reproduction: { before: "结果重复" }, planned_files: ["a.ts"], repair_contract: contractFixture }));
  it("requires a real bug field and dimensions for new reviews", () => {
    const contract = { ...contractFixture, acceptance_cases: [{ ...contractFixture.acceptance_cases[0], source_refs: ["bug:expected_result"] }] };
    expect(parseRepairContract(contract,investigation.evidence,{}).errors.length).toBeGreaterThan(0);
    expect(parseReviewResult('{"approved":true,"findings":[]}').approved).toBe(false);
  });
  it("requires a bounded readonly amended plan without weakening acceptance", () => {
    expect(scopeAmendment('{"root_cause":"共享逻辑需要提取","scope_amendment":{"files":["b.ts"],"reason":"提取公共接口"}}')).toEqual({ files: ["b.ts"], reason: "提取公共接口" });
    expect(() => validateAmendedScope(investigation,{ ...investigation, planned_files: ["a.ts","b.ts"] },["b.ts"],2)).not.toThrow();
    expect(() => validateAmendedScope(investigation,{ ...investigation, planned_files: ["a.ts","c.ts"] },["b.ts"],2)).toThrow("超出");
    expect(() => validateAmendedScope(investigation,{ ...investigation, repair_contract: { ...contractFixture, preserved_behaviors: ["不同条件"] } },[],2)).toThrow("验收条件");
  });
});
