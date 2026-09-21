/** 评审驱动的受控范围补充：批准规则、门禁保持与人工阻塞分类。 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  depotToRootRelative,
  normalizeReference,
  reviewScopeAmendment,
  reviewScopeAmendmentForWritten,
  resolveReviewReference,
  validateAmendedScope,
} from "../src/scopeAmendment.js";
import type { InvestigationResult } from "../src/repairWorkflow.js";
import type { ReviewResult } from "../src/review.js";
import { assessPlannedScope } from "../src/verify.js";

const BASE = "TypeScript/Src/Game/Module/RecruitBoard";
const CONTROLLER = `${BASE}/RecruitBoardController.ts`;
const MODEL = `${BASE}/RecruitBoardModel.ts`;
const DETAIL = `${BASE}/View/RecruitDetailItem.ts`;

const tmpdirs: string[] = [];

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-scope-"));
  tmpdirs.push(repo);
  for (const file of [CONTROLLER, MODEL, DETAIL]) {
    const target = path.join(repo, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const value = 1;\n");
  }
  return repo;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function investigation(plannedFiles: string[]): InvestigationResult {
  return {
    ok: true,
    root_cause: "申请状态未由模型驱动",
    evidence: ["[观察] RecruitBoardController.ts:257", "[推断] 根因由该观察事实支持"],
    reproduction: { command: "npm test", before: "FAIL" },
    diagnostic_pages: [],
    planned_files: plannedFiles,
    confidence: 0.9,
    blocked_reasons: [],
    validation_errors: [],
    open_questions: [],
    verification_limitations: [],
    repair_contract: {
      acceptance_cases: [{ given: "已进入目标功能", when: "触发操作", then: "返回预期结果", source_refs: ["evidence:0"] }],
      preserved_behaviors: ["正常输入继续完成原业务操作"],
      domain_facts: [{ concept: "申请状态", meaning: "按钮文案来源", source_refs: ["evidence:0"] }],
      reuse_options: [{ symbol: "入口", action: "reuse", reason: "沿用原入口" }],
      open_questions: [],
    },
  };
}

function review(findings: Array<Partial<ReviewResult["findings"][number]>>): ReviewResult {
  return {
    approved: false,
    note: "补丁未覆盖根因",
    requirement_match: "fail",
    behavioral_evidence: "static_only",
    reuse_and_lifecycle: "fail",
    unverified_items: [],
    findings: findings.map((finding) => ({
      severity: "high",
      title: "已申请状态未由模型驱动",
      file: "",
      line: null,
      evidence: "证据",
      required_action: "必须修正",
      ...finding,
    })) as ReviewResult["findings"],
  };
}

describe("评审驱动的受控范围补充", () => {
  it("批准评审明确指向的计划外 project 文件（含阻断性 finding 举证中的路径）", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const result = reviewScopeAmendment(review([{
      file: CONTROLLER,
      required_action: "在 RecruitDetailItem 中让模型记录驱动已申请状态",
      evidence: `（View/RecruitDetailItem.ts:320-331）；另见 ${MODEL}`,
    }]), roots, investigation([CONTROLLER]), 8);

    expect(result.approved).toEqual([`project:${DETAIL}`, `project:${MODEL}`]);
    expect(result.unapprovable).toEqual([]);
    expect(result.requested).toContain(CONTROLLER);
  });

  it("其它仓库/无关引用的举证不阻塞、也不扩围", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const result = reviewScopeAmendment(review([{
      file: CONTROLLER,
      required_action: "修正申请状态判定",
      evidence: "世界服只填 retcode（Source/Server/project/app/game/src/world/handler/world_team_handler.cpp:538-540）；"
        + "lobby_player_team_comp.cpp:2809；Util/ScrollView/ScrollViewDelegate.ts:113",
    }]), roots, investigation([CONTROLLER]), 8);

    expect(result.approved).toEqual([]);
    expect(result.unapprovable).toEqual([]);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });

  it("显式根别名但无法安全定位的扩围要求转人工（unapprovable，不静默忽略）", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const escaping = reviewScopeAmendment(review([{
      file: `project:${BASE}/NotThere.ts`,
    }]), roots, investigation([CONTROLLER]), 8);
    expect(escaping.unapprovable).toEqual([`project:${BASE}/NotThere.ts`]);
    expect(escaping.approved).toEqual([]);

    const traversal = reviewScopeAmendment(review([{
      file: "project:../../../secret.ts",
    }]), roots, investigation([CONTROLLER]), 8);
    expect(traversal.unapprovable).toEqual(["project:../../../secret.ts"]);

    const absolute = reviewScopeAmendment(review([{
      file: "project:C:/Windows/System32/drivers/etc/hosts.ts",
    }]), roots, investigation([CONTROLLER]), 8);
    expect(absolute.unapprovable).toEqual(["project:C:/Windows/System32/drivers/etc/hosts.ts"]);

    const unknownRoot = reviewScopeAmendment(review([{
      file: "engine:Source/Engine.ts",
    }]), roots, investigation([CONTROLLER]), 8);
    expect(unknownRoot.unapprovable).toEqual([]); // 未配置的根别名不是本工作区要求
    expect(unknownRoot.unresolved).toEqual(["engine:Source/Engine.ts"]);
  });

  it("超过 quality.max_changed_files 的扩围整体被拒绝并给出原因", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const result = reviewScopeAmendment(review([{
      file: MODEL,
      required_action: `同时修改 View/RecruitDetailItem.ts`,
    }]), roots, investigation([CONTROLLER]), 1);

    expect(result.approved).toEqual([]);
    expect(result.unapprovable).toEqual([`project:${MODEL}`, `project:${DETAIL}`]);
    expect(result.reason).toContain("范围补充");
  });

  it("low finding 与已批准评审不得驱动扩围；新文件需评审明确要求新建", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const low = reviewScopeAmendment(review([{ severity: "low", file: MODEL }]), roots, investigation([CONTROLLER]), 8);
    expect(low.approved).toEqual([]);
    expect(low.requested).toEqual([]);

    const approved = { ...review([{ file: MODEL }]), approved: true };
    expect(reviewScopeAmendment(approved, roots, investigation([CONTROLLER]), 8).approved).toEqual([]);

    const newFile = `${BASE}/Tests/RecruitBoardModel.spec.ts`;
    const declared = reviewScopeAmendment(review([{
      file: `project:${newFile}`,
      required_action: "新增测试文件覆盖刷新后的已申请状态",
    }]), roots, investigation([CONTROLLER]), 8);
    expect(declared.approved).toEqual([`project:${newFile}`]);

    const undeclared = reviewScopeAmendment(review([{
      file: `project:${newFile}`,
      required_action: "补齐刷新后的已申请状态",
    }]), roots, investigation([CONTROLLER]), 8);
    expect(undeclared.approved).toEqual([]);
    expect(undeclared.unapprovable).toEqual([`project:${newFile}`]);
  });

  it("correction 结果后只审批评审指名的越界写入，其余仍由范围门拒绝", () => {
    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    const pending = investigation([CONTROLLER]);
    const pendingReview = review([{
      file: CONTROLLER,
      required_action: "在 RecruitDetailItem 中让模型记录驱动已申请状态",
      evidence: "View/RecruitDetailItem.ts:320-331",
    }]);

    // 评审指名的越界写入 → 批准；没有评审指向的越界写入 → 不批准，门禁照旧拒绝。
    const demanded = reviewScopeAmendmentForWritten(
      pendingReview, roots, pending, 8,
      [`project://depot/${DETAIL}`],
    );
    expect(demanded.approved).toEqual([`project:${DETAIL}`]);
    expect(demanded.unapprovable).toEqual([]);
    expect(assessPlannedScope(
      [`project://depot/${DETAIL}`],
      [...pending.planned_files, ...demanded.approved],
    ).ok).toBe(true);

    const stray = reviewScopeAmendmentForWritten(
      pendingReview, roots, pending, 8,
      ["project://depot/Unrelated.ts"],
    );
    expect(stray.approved).toEqual([]);
    expect(stray.unapprovable).toEqual([]);
    expect(assessPlannedScope(
      ["project://depot/Unrelated.ts"],
      [...pending.planned_files, ...stray.approved],
    ).unplanned_files).toEqual(["project://depot/Unrelated.ts"]);
  });

  it("路径解析的边界：清洗行号/引号、拒绝越界、识别 depot 相对路径", () => {
    expect(normalizeReference("`View/A.ts:12-20`")).toBe("View/A.ts");
    expect(normalizeReference("project:TypeScript/Src/A.ts")).toBe("project:TypeScript/Src/A.ts");

    const repo = makeRepo();
    const roots = [{ alias: "project", path: repo }];
    expect(resolveReviewReference("../../etc/passwd.ts", roots, [CONTROLLER])).toBeUndefined();
    expect(resolveReviewReference("C:/Windows/hosts.ts", roots, [CONTROLLER])).toBeUndefined();
    expect(resolveReviewReference("project:*.ts", roots, [CONTROLLER])).toBeUndefined();
    expect(resolveReviewReference("View/RecruitDetailItem.ts", roots, [CONTROLLER])?.file)
      .toBe(`project:${DETAIL}`);
    // 同名多解 → 不可安全批准
    const otherDir = path.join(repo, "TypeScript", "Src", "Other", "View");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "RecruitDetailItem.ts"), "x");
    expect(resolveReviewReference("View/RecruitDetailItem.ts", roots,
      [CONTROLLER, "project:TypeScript/Src/Other/OtherController.ts"])).toBeUndefined();

    expect(depotToRootRelative("project://nami/branch_0.7.1/Source/Client/TypeScript/Src/A.ts",
      path.join(repo, "Source", "Client"))).toBe("TypeScript/Src/A.ts");
  });

  it("validateAmendedScope 仍然是数量与范围上限的唯一来源", () => {
    const current = investigation([CONTROLLER]);
    expect(() => validateAmendedScope(
      current,
      { ...current, planned_files: [CONTROLLER, `project:${MODEL}`] },
      [`project:${MODEL}`],
      8,
    )).not.toThrow();
    expect(() => validateAmendedScope(
      current,
      { ...current, planned_files: [CONTROLLER, `project:${MODEL}`] },
      [`project:${MODEL}`],
      1,
    )).toThrow("范围补充超出申请或删除了原计划文件");
    expect(() => validateAmendedScope(
      current,
      { ...current, planned_files: [`project:${MODEL}`] },
      [`project:${MODEL}`],
      8,
    )).toThrow("范围补充超出申请或删除了原计划文件");
  });
});
