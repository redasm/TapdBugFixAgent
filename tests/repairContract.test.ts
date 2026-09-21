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
  it("names the exact invalid source_ref and the reason instead of a generic message", () => {
    const withRef = (ref: string, fields?: Record<string, unknown>) => parseRepairContract(
      { ...contract, acceptance_cases: [{ ...contract.acceptance_cases[0], source_refs: [ref] }] }, evidence, fields,
    ).errors.join("\n");
    // 空工单字段
    expect(withRef("bug:expected_result", { expected_result: "" })).toContain("bug:expected_result");
    expect(withRef("bug:expected_result", { expected_result: "" })).toContain("为空");
    // evidence 越界
    expect(withRef("evidence:9")).toContain("evidence:9");
    expect(withRef("evidence:9")).toContain("越界");
    // 非 [观察] 项
    expect(withRef("evidence:1")).toContain("evidence:1");
    expect(withRef("evidence:1")).toContain("[观察]");
    // 非法格式
    expect(withRef("file:Invented.ts")).toContain("格式非法");
    // 空 source_refs
    expect(parseRepairContract({ ...contract, domain_facts: [{ ...contract.domain_facts[0], source_refs: [] }] }, evidence).errors.join("\n"))
      .toContain("缺少 source_refs");
  });
  it("routes unresolved business semantics to the human exit without burning a validation retry", () => {
    const parsed = parseInvestigation(JSON.stringify({ root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" }, repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] } }));
    expect(parsed.ok).toBe(false);
    // 不再是“格式/证据缺项”，因此不会触发自动重试
    expect(parsed.validation_errors).toEqual([]);
    expect(parsed.blocked_reasons.join()).toContain("业务条件尚未确认");
    expect(parsed.open_questions).toEqual(["玩家地图ID具体来自哪个字段？"]);
    expect(parsed.repair_contract.open_questions).toEqual(["玩家地图ID具体来自哪个字段？"]);
  });
  it("migrates pure execution limits to verification_limitations without blocking", () => {
    const base = { root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" } };
    const declared = parseInvestigation(JSON.stringify({ ...base, repair_contract: contract, verification_limitations: ["无法运行游戏内端到端验证"] }));
    expect(declared.ok).toBe(true);
    expect(declared.blocked_reasons).toEqual([]);
    expect(declared.validation_errors).toEqual([]);
    expect(declared.verification_limitations).toContain("无法运行游戏内端到端验证");
    // 被误写进 open_questions / blocked_reasons 的纯验证限制同样迁移，不阻断
    const migrated = parseInvestigation(JSON.stringify({ ...base, repair_contract: { ...contract, open_questions: ["无法运行游戏，缺少可运行客户端"] }, blocked_reasons: ["无法启动编辑器做资源侧复现"] }));
    expect(migrated.ok).toBe(true);
    expect(migrated.open_questions).toEqual([]);
    expect(migrated.blocked_reasons).toEqual([]);
    expect(migrated.verification_limitations.join("\n")).toContain("缺少可运行客户端");
    expect(migrated.verification_limitations.join("\n")).toContain("无法启动编辑器");
    // 限制不得被当成“修复前失败现象”这类已验证事实的替代品
    expect(migrated.repair_contract.open_questions).toEqual([]);
  });
  it("keeps blocking on business questions while preserving the limits that came with them", () => {
    const mixed = parseInvestigation(JSON.stringify({
      root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" },
      repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] },
      verification_limitations: ["无法运行游戏内端到端验证"],
    }));
    expect(mixed.ok).toBe(false);
    expect(mixed.blocked_reasons.join()).toContain("业务条件尚未确认");
    expect(mixed.verification_limitations).toContain("无法运行游戏内端到端验证");
  });
  it("gives an unconfirmable pre-fix baseline a human exit instead of a format-error retry", () => {
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "现有代码疑似已包含该修复",
      evidence: ["[观察] Map.ts:60 已按地图ID比较", "[推断] 现有实现已覆盖该场景"],
      planned_files: ["Map.ts"],
      reproduction: { command: "", before: "" },
      blocked_reasons: ["基线不可确认：当前代码疑似已包含修复，无法复现修复前失败"],
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.validation_errors).toEqual([]);
    expect(parsed.blocked_reasons.join()).toContain("基线不可确认");
  });
  it("keeps an unproven call chain in the retry path instead of the human exit", () => {
    const gap = parseInvestigation(JSON.stringify({
      root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: ["已找到 Map.ts，但未证实 OnClick 会进入预放置状态"],
    }));
    expect(gap.blocked_reasons).toEqual([]);
    expect(gap.validation_errors.join()).toContain("未证实");
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
