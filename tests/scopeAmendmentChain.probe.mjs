/**
 * 编译后最小探针：vitest 在本沙箱因 spawn EPERM 无法启动（tinypool/vite 都要 fork 子进程），
 * 这里用 dist/ 的编译产物直接跑 tests/scopeAmendment.test.ts 与 tests/core.test.ts 新增用例
 * 的等价断言，作为该完整链路的可执行证据。
 *
 * 唯一被替换的边界是操作系统的子进程：本沙箱禁止 spawn（校验命令由 runTests 通过 spawn 执行），
 * 因此用只回放 stdout 与 exit code 的假子进程替换 child_process.spawn/execFile
 * （必须在第一次 ESM 引入 node:child_process 之前替换）。其余全部走 dist/ 里的真实编译代码。
 *
 *   node run/_probe_chain.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
childProcess.spawn = (command) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => true;
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from(`probe: ${command} (faked exit 0)\n`));
    child.emit("close", 0);
    child.emit("exit", 0);
  }, 0);
  return child;
};
childProcess.execFile = (file, args, options, callback) => {
  if (typeof callback === "function") callback(null, "", "");
  return new EventEmitter();
};

const {
  depotToRootRelative,
  normalizeReference,
  reviewScopeAmendment,
  reviewScopeAmendmentForWritten,
  resolveReviewReference,
  validateAmendedScope,
} = await import("../dist/scopeAmendment.js");
const { assessPlannedScope } = await import("../dist/verify.js");
const { Worker } = await import("../dist/worker.js");
const { StateStore } = await import("../dist/state.js");
const { bugFromDict } = await import("../dist/models.js");
const { DEFAULT_PRIORITY_WEIGHT } = await import("../dist/config.js");
const { PiAgent } = await import("../dist/agent.js");
const { P4Client } = await import("../dist/p4.js");

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

// ---------------------------------------------------------------------------
// 与 tests/scopeAmendment.test.ts 等价的单元断言
// ---------------------------------------------------------------------------
const BASE = "TypeScript/Src/Game/Module/RecruitBoard";
const CONTROLLER = `${BASE}/RecruitBoardController.ts`;
const MODEL = `${BASE}/RecruitBoardModel.ts`;
const DETAIL = `${BASE}/View/RecruitDetailItem.ts`;
const tmpdirs = [];

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-scope-"));
  tmpdirs.push(repo);
  for (const file of [CONTROLLER, MODEL, DETAIL]) {
    const target = path.join(repo, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "export const value = 1;\n");
  }
  return repo;
}

function investigation(plannedFiles) {
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

function review(findings, over = {}) {
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
    })),
    ...over,
  };
}

it("unit: 批准评审明确指向的计划外 project 文件（含阻断性 finding 举证中的路径）", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const result = reviewScopeAmendment(review([{
    file: CONTROLLER,
    required_action: "在 RecruitDetailItem 中让模型记录驱动已申请状态",
    evidence: `（View/RecruitDetailItem.ts:320-331）；另见 ${MODEL}`,
  }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(result.approved, [`project:${DETAIL}`, `project:${MODEL}`]);
  assert.deepEqual(result.unapprovable, []);
  assert.ok(result.requested.includes(CONTROLLER));
});

it("unit: 其它仓库/无关引用的举证不阻塞、也不扩围", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const result = reviewScopeAmendment(review([{
    file: CONTROLLER,
    required_action: "修正申请状态判定",
    evidence: "世界服只填 retcode（Source/Server/project/app/game/src/world/handler/world_team_handler.cpp:538-540）；"
      + "lobby_player_team_comp.cpp:2809；Util/ScrollView/ScrollViewDelegate.ts:113",
  }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.unapprovable, []);
  assert.ok(result.unresolved.length > 0);
});

it("unit: 显式根别名但无法安全定位的扩围要求转人工（unapprovable）", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const missing = reviewScopeAmendment(review([{ file: `project:${BASE}/NotThere.ts` }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(missing.unapprovable, [`project:${BASE}/NotThere.ts`]);
  assert.deepEqual(missing.approved, []);

  const traversal = reviewScopeAmendment(review([{ file: "project:../../../secret.ts" }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(traversal.unapprovable, ["project:../../../secret.ts"]);

  const absolute = reviewScopeAmendment(review([{ file: "project:C:/Windows/System32/drivers/etc/hosts.ts" }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(absolute.unapprovable, ["project:C:/Windows/System32/drivers/etc/hosts.ts"]);

  const unknownRoot = reviewScopeAmendment(review([{ file: "engine:Source/Engine.ts" }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(unknownRoot.unapprovable, []);
  assert.deepEqual(unknownRoot.unresolved, ["engine:Source/Engine.ts"]);
});

it("unit: 超过 quality.max_changed_files 的扩围整体被拒绝并给出原因", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const result = reviewScopeAmendment(review([{
    file: MODEL,
    required_action: "同时修改 View/RecruitDetailItem.ts",
  }]), roots, investigation([CONTROLLER]), 1);
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.unapprovable, [`project:${MODEL}`, `project:${DETAIL}`]);
  assert.ok(result.reason.includes("范围补充"));
});

it("unit: low finding 与已批准评审不驱动扩围；新文件需评审明确要求新建", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const low = reviewScopeAmendment(review([{ severity: "low", file: MODEL }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(low.approved, []);
  assert.deepEqual(low.requested, []);

  const approvedReview = review([{ file: MODEL }], { approved: true });
  assert.deepEqual(reviewScopeAmendment(approvedReview, roots, investigation([CONTROLLER]), 8).approved, []);

  const newFile = `${BASE}/Tests/RecruitBoardModel.spec.ts`;
  const declared = reviewScopeAmendment(review([{
    file: `project:${newFile}`,
    required_action: "新增测试文件覆盖刷新后的已申请状态",
  }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(declared.approved, [`project:${newFile}`]);

  const undeclared = reviewScopeAmendment(review([{
    file: `project:${newFile}`,
    required_action: "补齐刷新后的已申请状态",
  }]), roots, investigation([CONTROLLER]), 8);
  assert.deepEqual(undeclared.approved, []);
  assert.deepEqual(undeclared.unapprovable, [`project:${newFile}`]);
});

it("unit: correction 结果后只审批评审指名的越界写入，其余仍由范围门拒绝", () => {
  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  const pending = investigation([CONTROLLER]);
  const pendingReview = review([{
    file: CONTROLLER,
    required_action: "在 RecruitDetailItem 中让模型记录驱动已申请状态",
    evidence: "View/RecruitDetailItem.ts:320-331",
  }]);
  const demanded = reviewScopeAmendmentForWritten(
    pendingReview, roots, pending, 8, [`project://depot/${DETAIL}`],
  );
  assert.deepEqual(demanded.approved, [`project:${DETAIL}`]);
  assert.deepEqual(demanded.unapprovable, []);
  assert.equal(assessPlannedScope([`project://depot/${DETAIL}`], [...pending.planned_files, ...demanded.approved]).ok, true);

  const stray = reviewScopeAmendmentForWritten(
    pendingReview, roots, pending, 8, ["project://depot/Unrelated.ts"],
  );
  assert.deepEqual(stray.approved, []);
  assert.deepEqual(stray.unapprovable, []);
  assert.deepEqual(
    assessPlannedScope(["project://depot/Unrelated.ts"], [...pending.planned_files, ...stray.approved]).unplanned_files,
    ["project://depot/Unrelated.ts"],
  );
});

it("unit: 路径解析边界（清洗行号/引号、越界、多解、depot 相对路径）", () => {
  assert.equal(normalizeReference("`View/A.ts:12-20`"), "View/A.ts");
  assert.equal(normalizeReference("project:TypeScript/Src/A.ts"), "project:TypeScript/Src/A.ts");

  const repo = makeRepo();
  const roots = [{ alias: "project", path: repo }];
  assert.equal(resolveReviewReference("../../etc/passwd.ts", roots, [CONTROLLER]), undefined);
  assert.equal(resolveReviewReference("C:/Windows/hosts.ts", roots, [CONTROLLER]), undefined);
  assert.equal(resolveReviewReference("project:*.ts", roots, [CONTROLLER]), undefined);
  assert.equal(resolveReviewReference("View/RecruitDetailItem.ts", roots, [CONTROLLER]).file, `project:${DETAIL}`);

  const otherDir = path.join(repo, "TypeScript", "Src", "Other", "View");
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, "RecruitDetailItem.ts"), "x");
  assert.equal(
    resolveReviewReference("View/RecruitDetailItem.ts", roots,
      [CONTROLLER, "project:TypeScript/Src/Other/OtherController.ts"]),
    undefined,
  );
  assert.equal(
    depotToRootRelative("project://nami/branch_0.7.1/Source/Client/TypeScript/Src/A.ts", path.join(repo, "Source", "Client")),
    "TypeScript/Src/A.ts",
  );
});

it("unit: validateAmendedScope 仍是数量与范围上限的唯一来源", () => {
  const current = investigation([CONTROLLER]);
  validateAmendedScope(current, { ...current, planned_files: [CONTROLLER, `project:${MODEL}`] }, [`project:${MODEL}`], 8);
  assert.throws(
    () => validateAmendedScope(current, { ...current, planned_files: [CONTROLLER, `project:${MODEL}`] }, [`project:${MODEL}`], 1),
    /范围补充超出申请或删除了原计划文件/,
  );
  assert.throws(
    () => validateAmendedScope(current, { ...current, planned_files: [`project:${MODEL}`] }, [`project:${MODEL}`], 8),
    /范围补充超出申请或删除了原计划文件/,
  );
});

// ---------------------------------------------------------------------------
// 与 tests/core.test.ts 新增用例等价的完整链路断言
// ---------------------------------------------------------------------------
const originalProto = {
  run: PiAgent.prototype.run,
  opened: P4Client.prototype.opened,
  sync: P4Client.prototype.sync,
  edit: P4Client.prototype.edit,
  revertUnchanged: P4Client.prototype.revertUnchanged,
  reconcilePreview: P4Client.prototype.reconcilePreview,
  reconcile: P4Client.prototype.reconcile,
  diffUnified: P4Client.prototype.diffUnified,
  createPending: P4Client.prototype.createPending,
  revert: P4Client.prototype.revert,
};
function restorePrototypes() {
  PiAgent.prototype.run = originalProto.run;
  for (const key of Object.keys(originalProto)) {
    if (key === "run") continue;
    P4Client.prototype[key] = originalProto[key];
  }
}

function makeBug(over = {}) {
  const data = {
    id: "1123456780001234007",
    workspace_id: "1123456780",
    title: "登录页偶现崩溃",
    description: "在快速点击登录按钮时偶现崩溃，堆栈在 xxx。",
    status: "new",
    priority: "1",
    priority_label: "高",
    severity: "严重",
    module: "login",
    current_owner: "me",
    reporter: "tester",
    created: "2026-08-05 10:00:00",
    ...over,
  };
  return bugFromDict(data, String(data.workspace_id));
}

function makeResult(over = {}) {
  return {
    ok: true, summary: "", changed_files: [], manual_assets: [], blocked_reasons: [],
    exit_code: 0, log: "", raw_output: "", ...over,
  };
}

function makeInvestigation(file) {
  return makeResult({
    raw_output: `FINAL_RESULT: {"repair_contract":{"acceptance_cases":[{"given":"已进入目标功能","when":"触发工单操作","then":"返回预期结果且不再出现目标异常","source_refs":["evidence:0"]}],"preserved_behaviors":["正常输入继续完成原业务操作"],"domain_facts":[{"concept":"操作状态","meaning":"本次操作的业务结果","source_refs":["evidence:0"]}],"reuse_options":[{"symbol":"目标操作入口","action":"reuse","reason":"沿用原入口及错误处理路径"}],"open_questions":[]},"root_cause":"测试根因","evidence":["[观察] ${file}:1","[推断] 根因由该观察事实支持"],"reproduction":{"command":"","before":"复现失败"},"planned_files":["${file}"],"confidence":0.9,"blocked_reasons":[]}`,
  });
}

function makeWorker(repos) {
  const store = new StateStore(":memory:");
  const cfg = {
    max_bugs_per_run: 10,
    max_attempts: 1,
    agent_timeout_s: 900,
    mcp_servers: {},
    quality: {
      admission: { min_score: 0, require_reproduction_signal: false, manual_keywords: [] },
      require_verification: false,
      max_changed_files: 8,
      max_diff_lines: 500,
    },
    review: { enabled: false, max_fix_rounds: 0 },
    exclude_status: ["resolved", "closed", "rejected"],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [{ workspace_id: "111", owner: "me", repos, default_repo: "" }],
    pi: { provider: undefined },
    p4: {}, web: {}, tapd: {}, config_path: "",
  };
  const worker = new Worker(cfg, store);
  worker.clients["111"] = { addComment: async () => {}, updateBug: async () => {} };
  worker.fetchMyBugs = async () => worker.__bugs ?? [];
  return worker;
}

function installP4(overrides = {}) {
  P4Client.prototype.sync = async () => "";
  P4Client.prototype.edit = async () => "";
  P4Client.prototype.revertUnchanged = async () => "";
  P4Client.prototype.revert = async () => "";
  P4Client.prototype.reconcilePreview = async () => "";
  P4Client.prototype.reconcile = async () => "";
  P4Client.prototype.opened = async () => [];
  P4Client.prototype.diffUnified = async () => "--- a/x\n+++ b/x\n-old\n+fixed";
  P4Client.prototype.createPending = async () => 4321;
  Object.assign(P4Client.prototype, overrides);
}

async function runScenario({ calls, opened, repoDir, results, reviewEnabled = true, maxFixRounds = 1, maxAttempts = 2, tweak }) {
  restorePrototypes();
  const worker = makeWorker([{ name: "r", path: repoDir, verify_cmds: ['node -e "process.exit(0)"'] }]);
  worker.config.review.enabled = reviewEnabled;
  worker.config.review.max_fix_rounds = maxFixRounds;
  worker.config.max_attempts = maxAttempts;
  tweak?.(worker);
  const bug = makeBug();
  worker.__bugs = [bug];
  PiAgent.prototype.run = async (opts) => {
    calls.push(opts);
    return results[calls.length - 1](opts);
  };
  let openedCalls = 0;
  installP4({
    opened: async () => {
      openedCalls += 1;
      return openedCalls === 1 ? [] : opened();
    },
  });
  await worker.processBug(bug);
  restorePrototypes();
  return { worker, bug };
}

const FILE_A = { depot: "//depot/RecruitBoardController.ts", action: "edit", changelist: "default", type: "text" };
const FILE_B = { depot: "//depot/View/RecruitDetailItem.ts", action: "edit", changelist: "default", type: "text" };
const FILE_X = { depot: "//depot/Unrelated.ts", action: "edit", changelist: "default", type: "text" };

const REJECT_WITH_OUT_OF_PLAN = 'FINAL_RESULT: {"approved":false,"requirement_match":"fail","behavioral_evidence":"static_only","reuse_and_lifecycle":"fail","unverified_items":[],"note":"根因未覆盖","findings":[{"severity":"high","title":"已申请状态未由模型驱动","file":"RecruitBoardController.ts","line":5,"evidence":"条目渲染只在申请回调里设置已申请（View/RecruitDetailItem.ts:320-331）","required_action":"在 View/RecruitDetailItem.ts 中让模型记录驱动已申请状态"}]}';
const APPROVE = 'FINAL_RESULT: {"approved":true,"requirement_match":"pass","behavioral_evidence":"static_only","reuse_and_lifecycle":"pass","unverified_items":[],"note":"问题已修复","findings":[]}';

it("chain: Reviewer 驳回要求计划外文件 → 受控扩围 → 修正两个文件 → 复验通过 → 复审通过", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-probe-"));
  tmpdirs.push(repoDir);
  fs.mkdirSync(path.join(repoDir, "View"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "RecruitBoardController.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repoDir, "View", "RecruitDetailItem.ts"), "export const b = 1;\n");
  const calls = [];
  let corrected = false;
  const { worker, bug } = await runScenario({
    calls, repoDir,
    opened: () => (corrected ? [FILE_A, FILE_B] : [FILE_A]),
    results: [
      () => makeInvestigation("RecruitBoardController.ts"),
      () => makeResult({ changed_files: ["project:RecruitBoardController.ts"], summary: "首轮修复" }),
      () => makeResult({ raw_output: REJECT_WITH_OUT_OF_PLAN }),
      () => { corrected = true; return makeResult({ changed_files: ["project:RecruitBoardController.ts", "project:View/RecruitDetailItem.ts"], summary: "按评审要求修正两个文件" }); },
      () => makeResult({ raw_output: APPROVE }),
    ],
  });
  assert.equal(calls.length, 5, "调查→实施→评审→修正→复审");
  assert.ok(String(calls[3].prompt).includes("本轮受控范围补充"), "修正提示必须声明已批准的范围补充");
  assert.ok(String(calls[3].prompt).includes("project:View/RecruitDetailItem.ts"), "修正提示必须列出获批的新文件");
  assert.ok(String(calls[3].prompt).includes("已通过编排器校验"), "修正提示必须把获批文件标为本次计划范围");
  assert.ok(String(calls[3].prompt).includes("不得因它们报告范围阻塞"), "获批文件不得再触发范围阻塞");
  const attempt = worker.store.audit.attempts(bug.id)[0];
  const approvedEvent = attempt.events.find((event) => event.kind === "scope_amendment_approved");
  console.log("  audit scope_amendment_approved:", JSON.stringify(approvedEvent?.payload));
  console.log("  audit source_candidate:", JSON.stringify(attempt.events.find((event) => event.kind === "source_candidate")?.payload));
  assert.equal(approvedEvent?.payload.source, "review");
  assert.equal(approvedEvent?.payload.stage, "correction");
  assert.deepEqual(approvedEvent?.payload.approved, ["project:View/RecruitDetailItem.ts"]);
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "review_pending");
  assert.equal(worker.store.audit.candidates(bug.id).length, 1, "链路走通并留下候选证据");
  const verification = JSON.parse(String(worker.store.getJob(bug.id)?.verification ?? "{}"));
  assert.deepEqual(verification.opened?.map((item) => item.depot), ["//depot/RecruitBoardController.ts", "//depot/View/RecruitDetailItem.ts"]);
});

it("chain: 扩围要求无法安全批准 → blocked_workspace，不进入注定失败的修正轮", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-probe-"));
  tmpdirs.push(repoDir);
  fs.writeFileSync(path.join(repoDir, "RecruitBoardController.ts"), "export const a = 1;\n");
  const calls = [];
  const { worker, bug } = await runScenario({
    calls, repoDir, opened: () => [FILE_A],
    results: [
      () => makeInvestigation("RecruitBoardController.ts"),
      () => makeResult({ changed_files: ["project:RecruitBoardController.ts"], summary: "首轮修复" }),
      () => makeResult({ raw_output: 'FINAL_RESULT: {"approved":false,"requirement_match":"fail","behavioral_evidence":"static_only","reuse_and_lifecycle":"fail","unverified_items":[],"note":"需要改计划外文件","findings":[{"severity":"high","title":"必须改动未纳入范围的文件","file":"project:View/MissingItem.ts","line":12,"evidence":"该文件当前仍是旧逻辑","required_action":"修改 project:View/MissingItem.ts 中的状态判定"}]}' }),
    ],
  });
  assert.equal(calls.length, 3, "不进入 correction");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "blocked_workspace");
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("无法安全纳入"));
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 0, "操作阻塞不消耗修复重试");
  assert.ok(worker.store.audit.attempts(bug.id)[0].events.some((event) => event.kind === "scope_amendment_rejected"));
});

it("chain: 扩围超过 quality.max_changed_files → 同样转人工阻塞", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-probe-"));
  tmpdirs.push(repoDir);
  fs.writeFileSync(path.join(repoDir, "RecruitBoardController.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repoDir, "RecruitBoardModel.ts"), "export const b = 1;\n");
  const calls = [];
  const { worker, bug } = await runScenario({
    calls, repoDir, opened: () => [FILE_A],
    tweak: (worker) => { worker.config.quality.max_changed_files = 1; },
    results: [
      () => makeInvestigation("RecruitBoardController.ts"),
      () => makeResult({ changed_files: ["project:RecruitBoardController.ts"], summary: "首轮修复" }),
      () => makeResult({ raw_output: 'FINAL_RESULT: {"approved":false,"requirement_match":"fail","behavioral_evidence":"static_only","reuse_and_lifecycle":"fail","unverified_items":[],"note":"需要改模型文件","findings":[{"severity":"high","title":"模型记录未驱动渲染","file":"RecruitBoardModel.ts","line":62,"evidence":"模型没有提供已申请记录","required_action":"在 RecruitBoardModel.ts 中补充已申请记录查询"}]}' }),
    ],
  });
  assert.equal(calls.length, 3);
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "blocked_workspace");
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("计划文件上限 1"));
});

it("chain: Reviewer 未指名的越界改动仍然被范围门拒绝（扩围不放宽门禁）", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-probe-"));
  tmpdirs.push(repoDir);
  fs.writeFileSync(path.join(repoDir, "RecruitBoardController.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repoDir, "Unrelated.ts"), "export const c = 1;\n");
  const calls = [];
  let overreached = false;
  const { worker, bug } = await runScenario({
    calls, repoDir, opened: () => (overreached ? [FILE_A, FILE_X] : [FILE_A]), maxAttempts: 1,
    results: [
      () => makeInvestigation("RecruitBoardController.ts"),
      () => makeResult({ changed_files: ["project:RecruitBoardController.ts"], summary: "首轮修复" }),
      () => makeResult({ raw_output: 'FINAL_RESULT: {"approved":false,"requirement_match":"fail","behavioral_evidence":"static_only","reuse_and_lifecycle":"fail","unverified_items":[],"note":"逻辑仍有遗漏","findings":[{"severity":"high","title":"状态判定仍不完整","file":"RecruitBoardController.ts","line":5,"evidence":"分支未覆盖","required_action":"补齐 RecruitBoardController.ts 的分支"}]}' }),
      () => { overreached = true; return makeResult({ changed_files: ["project:RecruitBoardController.ts", "project:Unrelated.ts"], summary: "顺手改了无关文件" }); },
    ],
  });
  const kinds = worker.store.audit.attempts(bug.id)[0].events.map((event) => event.kind);
  assert.ok(!kinds.includes("scope_amendment_approved"), "没有评审指向就不批准");
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("超出调查阶段计划范围"));
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "manual_review");
  assert.ok(Number(worker.store.getJob(bug.id)?.changelist) > 0, "越界改动仍被保留到人工评审 changelist");
});

// ---------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}\n${error?.stack ?? error}`);
  }
}
for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} probe cases passed`);
process.exit(failed ? 1 : 0);
