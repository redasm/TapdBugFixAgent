import { describe, it, expect } from "vitest";
import {
  WORKSPACE_SAFETY_BLOCK_GUIDANCE,
  buildImplementationPrompt,
  buildInvestigationPrompt,
  isWorkspaceSafetyReason,
  parseInvestigation,
} from "../src/repairWorkflow.js";
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
  it("turns unresolved business semantics into evidence gaps for supplementary investigation, not a human exit", () => {
    const parsed = parseInvestigation(JSON.stringify({ root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" }, repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] } }));
    expect(parsed.ok).toBe(false);
    // 不再是人工出口：转成「调查证据尚未收敛」校验缺项 → 定向补查 → 普通自动重试（耗尽后 failed）
    expect(parsed.blocked_reasons).toEqual([]);
    expect(parsed.validation_errors.join()).toContain("调查证据尚未收敛");
    expect(parsed.validation_errors.join()).toContain("玩家地图ID具体来自哪个字段？");
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
  it("keeps business questions in the auto-retry path while preserving the limits that came with them", () => {
    const mixed = parseInvestigation(JSON.stringify({
      root_cause: "路径条件错误", evidence, planned_files: ["Map.ts"], reproduction: { before: "跨地图仍发送请求" },
      repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] },
      verification_limitations: ["无法运行游戏内端到端验证"],
    }));
    expect(mixed.ok).toBe(false);
    expect(mixed.blocked_reasons).toEqual([]);
    expect(mixed.validation_errors.join()).toContain("调查证据尚未收敛");
    expect(mixed.verification_limitations).toContain("无法运行游戏内端到端验证");
  });
  it("keeps an unconfirmable pre-fix baseline in the auto-retry path instead of the human exit", () => {
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "现有代码疑似已包含该修复",
      evidence: ["[观察] Map.ts:60 已按地图ID比较", "[推断] 现有实现已覆盖该场景"],
      planned_files: ["Map.ts"],
      reproduction: { command: "", before: "" },
      blocked_reasons: ["基线不可确认：当前代码疑似已包含修复，无法复现修复前失败"],
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_reasons).toEqual([]);
    expect(parsed.validation_errors.join()).toContain("调查证据尚未收敛");
    expect(parsed.validation_errors.join()).toContain("基线不可确认");
    expect(parsed.validation_errors.join()).toContain("缺少修复前失败现象");
  });
  it("keeps genuine workspace or permission blocks as the only investigation human exit", () => {
    const blocked = parseInvestigation(JSON.stringify({
      root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: [
        "目标不在允许访问的工作目录中",
        "存在安全风险，无法在当前工作区内进行最小修改",
      ],
    }));
    expect(blocked.ok).toBe(false);
    expect(blocked.blocked_reasons).toEqual([
      "目标不在允许访问的工作目录中",
      "存在安全风险，无法在当前工作区内进行最小修改",
    ]);
    expect(blocked.validation_errors).toEqual([]);
    // 检测器必须只认真正的工作区/权限阻塞，不把调查缺口或基线问题误判成人工出口
    expect(isWorkspaceSafetyReason("目标不在允许访问的工作目录中")).toBe(true);
    expect(isWorkspaceSafetyReason("基线不可确认：无法复现修复前失败")).toBe(false);
    expect(isWorkspaceSafetyReason("未证实 OnClick 会进入预放置状态")).toBe(false);
    expect(isWorkspaceSafetyReason("无法根据标题、描述及现有代码定位问题")).toBe(false);
  });
  it("keeps an unproven call chain in the retry path instead of the human exit", () => {
    const gap = parseInvestigation(JSON.stringify({
      root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: ["已找到 Map.ts，但未证实 OnClick 会进入预放置状态"],
    }));
    expect(gap.blocked_reasons).toEqual([]);
    expect(gap.validation_errors.join()).toContain("未证实");
  });

  it("only accepts the four explicit workspace/permission conclusions as a real safety block", () => {
    // 正例：明确目标不在允许范围 / 明确缺权限无法读写 / 无法在当前工作区安全修改 / 无法安全选择目标
    for (const reason of [
      "目标修改路径不在允许访问的工作目录内",
      "目标仓库不在允许范围内",
      "超出本次允许访问的工作目录",
      "当前工作区缺少写权限，无法读取或写入目标文件",
      "目标仓库无修改权限，无法写入",
      "当前工作区权限不足，无法读取目标文件",
      "无法在当前工作区安全修改目标文件",
      "存在安全风险，无法在当前工作区内进行最小修改",
      "无法安全选择目标仓库或修改位置",
    ]) {
      expect(isWorkspaceSafetyReason(reason), reason).toBe(true);
    }
    // 反例：纯证据陈述不能被误判成工作区阻塞
    for (const reason of [
      "未确认该改动是否存在安全风险",
      "证据缺口：无法读取工作区之外的外部依赖版本",
      "该符号定义在 project 工作区之外的同名模块中，未能核对",
      "Bug 所属仓库无法判断",
    ]) {
      expect(isWorkspaceSafetyReason(reason), reason).toBe(false);
    }
  });

  it("routes the four evidence-gap statements to supplementary investigation, not the human exit", () => {
    const gaps = [
      "未确认该改动是否存在安全风险",
      "证据缺口：无法读取工作区之外的外部依赖版本",
      "该符号定义在 project 工作区之外的同名模块中，未能核对",
      "Bug 所属仓库无法判断",
    ];
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "路径条件错误",
      evidence,
      planned_files: ["Map.ts"],
      reproduction: { command: "npm test -- map", before: "跨地图仍发送请求" },
      repair_contract: contract,
      blocked_reasons: gaps,
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_reasons).toEqual([]);
    expect(parsed.validation_errors.join()).toContain("调查证据尚未收敛");
    for (const gap of gaps) expect(parsed.validation_errors.join(), gap).toContain(gap);
  });

  it("keeps the ordinary gaps visible when a real workspace block is mixed in", () => {
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: [
        "目标修改路径不在允许访问的工作目录内",
        "该符号定义在 project 工作区之外的同名模块中，未能核对",
      ],
    }));
    // 安全阻塞照旧转人工，但普通缺口不能被静默丢掉：必须留在 validation_errors 供展示/补查
    expect(parsed.blocked_reasons).toEqual(["目标修改路径不在允许访问的工作目录内"]);
    expect(parsed.validation_errors.join()).toContain("调查证据尚未收敛");
    expect(parsed.validation_errors.join()).toContain("该符号定义在 project 工作区之外的同名模块中");
    expect(parsed.ok).toBe(false);
  });

  it("keeps the investigation prompt wording parseable by the same classifier", () => {
    const prompt = buildInvestigationPrompt(
      bugFromDict({ id: "1123456780001273338", title: "自定义标记跨地图传送", description: "" }, "111"),
      "app",
      "C:\\repo",
    );
    for (const item of WORKSPACE_SAFETY_BLOCK_GUIDANCE) {
      expect(prompt, item).toContain(item);
      const example = item.match(/例：([^）]+)/)?.[1];
      expect(example, item).toBeTruthy();
      // 提示里推荐的每条措辞都必须能被解析器认成安全阻塞，否则提示与解析器不一致
      expect(isWorkspaceSafetyReason(example!), example).toBe(true);
    }
    // 提示必须同时写明「Bug 所属仓库无法判断」这类陈述不构成阻塞（否则与解析器矛盾）
    expect(prompt).toContain("Bug 所属仓库无法判断");
    expect(prompt).toContain("不构成阻塞");
    expect(prompt).toContain("无法安全选择目标仓库");
  });

  it("never feeds an unconfirmable pre-fix baseline text to the fixer as reproduction.before", () => {
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "现有代码疑似已包含该修复",
      evidence: ["[观察] Map.ts:60 已按地图ID比较", "[推断] 现有实现已覆盖该场景"],
      planned_files: ["Map.ts"],
      reproduction: { command: "npm test -- map", before: "基线不可确认：当前代码疑似已包含修复，无法复现修复前失败" },
      repair_contract: contract,
    }));
    // 未收敛：先定向补查，再按普通失败自动重试；不得当成可实施结论
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_reasons).toEqual([]);
    expect(parsed.validation_errors.join()).toContain("调查证据尚未收敛");
    expect(parsed.validation_errors.join()).toContain("不能当作真实失败基线");
    // 防御性：即便下游拿到该结果，也不能把这段原文当失败现象展示，更不得编造 before
    const prompt = buildImplementationPrompt({
      bug: bugFromDict({ id: "1123456780001273339", title: "自定义标记跨地图传送", description: "" }, "111"),
      repoName: "app",
      repoPath: "C:\\repo",
      verifyCommands: [],
      investigation: { ...parsed, ok: true },
      retryEvidence: "",
      reviewerFeedback: "",
    });
    expect(prompt).not.toContain("修复前失败现象: 基线不可确认");
    expect(prompt).toContain("修复前失败现象: （调查阶段未确认可核查的修复前失败现象");
  });

  it("still accepts a real observed failure as reproduction.before", () => {
    const parsed = parseInvestigation(JSON.stringify({
      root_cause: "路径条件错误",
      evidence,
      planned_files: ["Map.ts"],
      reproduction: { command: "npm test -- map", before: "FAIL Map.spec.ts: 跨地图仍发送请求" },
      repair_contract: contract,
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.validation_errors).toEqual([]);
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
