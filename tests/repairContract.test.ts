import { describe, it, expect } from "vitest";
import { parseInvestigation } from "../src/repairWorkflow.js";
import { parseRepairContract } from "../src/repairContract.js";
import { selectFeedbackMemories, type FeedbackMemory } from "../src/feedbackMemory.js";
import { bugFromDict } from "../src/models.js";
import { parseReviewResult } from "../src/review.js";

const contract = {
  acceptance_cases: [{ given: "玩家地图ID为A且标记地图ID为B", when: "点击传送", then: "显示提示且不发送传送请求", source_refs: ["evidence:0"] }],
  preserved_behaviors: ["同地图可正常传送"],
  domain_facts: [{ concept: "MapId", meaning: "地图的业务标识，与资源路径不等价", source_refs: ["evidence:0"] }],
  reuse_options: [{ symbol: "OnGotoClick", action: "reuse", reason: "保留既有同地图传送链" }],
  open_questions: [],
};
const evidence = ["[观察] Map.ts:1 MapId 来自目标地图配置", "[推断] 路径不能代表地图身份"];

describe("business acceptance evidence", () => {
  it("rejects missing contracts and references to assumptions or nonexistent evidence", () => {
    expect(parseInvestigation(JSON.stringify({ root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" } })).ok).toBe(false);
    expect(parseRepairContract(contract, evidence).errors).toEqual([]);
    for (const ref of ["evidence:1", "evidence:9", "file:Invented.ts"]) {
      expect(parseRepairContract({ ...contract, acceptance_cases: [{ ...contract.acceptance_cases[0], source_refs: [ref] }] }, evidence).errors.length).toBeGreaterThan(0);
    }
  });
  it("does not silently turn unresolved business semantics into an executable plan", () => {
    const parsed = parseInvestigation(JSON.stringify({ root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" }, repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] } }));
    expect(parsed.ok).toBe(false);
    expect(parsed.validation_errors.join()).toContain("业务条件尚未确认");
  });
});

describe("feedback retrieval", () => {
  const bug = bugFromDict({ id: "1123456780001273338", title: "自定义标记跨地图传送" }, "111");
  const memory = (id: string, group = id): FeedbackMemory => ({ id, bug_id: id, group, title: "自定义标记跨地图传送", outcome: "accepted_modified", lesson: "比较地图ID，不比较资源路径", source: "candidate:test", status: "human_feedback_requires_code_check", created_at: "2026-09-01T00:00:00Z" });
  it("uses human retry feedback but excludes same-bug and same-family answers in evaluation", () => {
    const entries = [memory(bug.id), memory("variant", "same-family"), memory("independent")];
    expect(selectFeedbackMemories(bug, entries)[0].bug_id).toBe(bug.id);
    expect(selectFeedbackMemories(bug, entries, { mode: "evaluation", excluded_groups: ["same-family"] }).map(m => m.bug_id)).toEqual(["independent"]);
  });
  it("respects context and temporal budgets", () => {
    expect(selectFeedbackMemories(bug, [memory("a")], { max_chars: 10 })).toEqual([]);
    expect(selectFeedbackMemories(bug, [memory("a")], { before: "2026-08-01T00:00:00Z" })).toEqual([]);
  });
});

describe("independent reviewer decisions", () => {
  const review = { approved: true, note: "类型检查通过，运行时待验收", findings: [], requirement_match: "pass", behavioral_evidence: "static_only", reuse_and_lifecycle: "pass", unverified_items: ["编辑器内复测"] };
  it.each(["requirement_match", "behavioral_evidence", "reuse_and_lifecycle", "unverified_items"])("requires %s in every review", field => {
    const incomplete: Record<string, unknown> = { ...review };
    delete incomplete[field];
    expect(parseReviewResult(JSON.stringify(incomplete))).toMatchObject({
      approved: false, requirement_match: "unknown", behavioral_evidence: "unknown", reuse_and_lifecycle: "unknown",
    });
  });
  it("preserves uncovered runtime checks without claiming they passed", () => {
    expect(parseReviewResult(JSON.stringify(review))).toMatchObject({ approved: true, behavioral_evidence: "static_only", unverified_items: ["编辑器内复测"] });
  });
  it("rejects wrong business semantics even when the reviewer writes approved=true", () => {
    expect(parseReviewResult(JSON.stringify({ ...review, requirement_match: "fail" })).approved).toBe(false);
  });
  it("does not downgrade medium defects based on manual-verification wording", () => {
    expect(parseReviewResult(JSON.stringify({ ...review, findings: [{ severity: "medium", title: "缺少游戏内验证", evidence: "地图ID不同但路径相同，当前分支仍会发起传送", file: "Map.ts", line: 1, required_action: "运行期核对地图ID并修正条件" }] })).approved).toBe(false);
  });
});
