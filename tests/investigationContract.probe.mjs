/**
 * 编译后最小探针：本沙箱里 vitest 无法启动（tinypool fork 子进程被拒：spawn EPERM），
 * 因此用 dist/ 的编译产物跑 tests/repairContract.test.ts、tests/investigationProgress.test.ts、
 * tests/quality.test.ts 中「调查契约分流」相关用例的等价断言，并额外覆盖截图场景的完整交付链路。
 *
 *   node tests/investigationContract.probe.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 只替换操作系统子进程边界（本沙箱禁止 spawn 管道），其余全部走 dist/ 里的真实编译代码。
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
  BASELINE_UNCONFIRMED_PREFIX,
  BUSINESS_QUESTION_PREFIX,
  buildImplementationPrompt,
  buildInvestigationContinuationPrompt,
  buildInvestigationPrompt,
  parseInvestigation,
} = await import("../dist/repairWorkflow.js");
const { parseRepairContract, isVerificationLimitation } = await import("../dist/repairContract.js");
const { captureInvestigationProgress } = await import("../dist/investigationProgress.js");
const { buildReviewPrompt } = await import("../dist/review.js");
const { buildDescription } = await import("../dist/descgen.js");
const { bugFromDict } = await import("../dist/models.js");
const { Worker } = await import("../dist/worker.js");
const { StateStore } = await import("../dist/state.js");
const { DEFAULT_PRIORITY_WEIGHT } = await import("../dist/config.js");
const { PiAgent } = await import("../dist/agent.js");
const { P4Client } = await import("../dist/p4.js");

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

const evidence = ["[观察] Map.ts:1 MapId 来自目标地图配置", "[推断] 路径不能代表地图身份"];
const contract = {
  acceptance_cases: [{ given: "玩家地图ID为A且标记地图ID为B", when: "点击传送", then: "显示提示且不发送传送请求", source_refs: ["evidence:0"] }],
  preserved_behaviors: ["同地图可正常传送"],
  domain_facts: [{ concept: "MapId", meaning: "地图的业务标识，与资源路径不等价", source_refs: ["evidence:0"] }],
  reuse_options: [{ symbol: "OnGotoClick", action: "reuse", reason: "保留既有同地图传送链" }],
  open_questions: [],
};
const base = {
  root_cause: "路径条件错误",
  evidence,
  reproduction: { command: "npm test -- map", before: "跨地图仍发送请求" },
  planned_files: ["Map.ts"],
  confidence: 0.8,
  blocked_reasons: [],
};

const investigationOf = (extra) => parseInvestigation(JSON.stringify({ ...base, repair_contract: contract, ...extra }));
const bug = bugFromDict({ id: "1123456780001257090", name: "自定义标记跨地图传送", description: "标记地图ID与玩家地图ID不同时仍会传送" }, "12345678");

// ---------------------------------------------------------------------------
// 1) 分流矩阵
// ---------------------------------------------------------------------------
it("分流：业务未决问题 -> blocked/needs_info，且不进入 validation_errors", () => {
  const parsed = investigationOf({ repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] } });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.validation_errors, [], "业务问题不得混进校验缺项（否则会触发自动重试）");
  assert.ok(parsed.blocked_reasons.join().includes(BUSINESS_QUESTION_PREFIX), "必须走阻断/人工出口");
  assert.deepEqual(parsed.open_questions, ["玩家地图ID具体来自哪个字段？"]);
});

it("分流：纯验证限制 -> verification_limitations，不阻断、不校验失败", () => {
  const parsed = investigationOf({ repair_contract: contract, verification_limitations: ["无法运行游戏内端到端验证"] });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.blocked_reasons, []);
  assert.deepEqual(parsed.validation_errors, []);
  assert.deepEqual(parsed.verification_limitations, ["无法运行游戏内端到端验证"]);
});

it("分流：误写进 open_questions / blocked_reasons 的验证限制被迁移，不阻断", () => {
  const migrated = investigationOf({
    repair_contract: { ...contract, open_questions: ["无法运行游戏，缺少可运行客户端"] },
    blocked_reasons: ["无法启动编辑器做资源侧复现"],
  });
  assert.equal(migrated.ok, true);
  assert.deepEqual(migrated.open_questions, []);
  assert.deepEqual(migrated.blocked_reasons, []);
  assert.ok(migrated.verification_limitations.join("\n").includes("缺少可运行客户端"));
  assert.ok(migrated.verification_limitations.join("\n").includes("无法启动编辑器"));
});

it("分流：混合时业务问题仍阻断，限制保留", () => {
  const mixed = investigationOf({
    repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] },
    verification_limitations: ["无法运行游戏，仅有截图证据"],
  });
  assert.equal(mixed.ok, false);
  assert.ok(mixed.blocked_reasons.join().includes(BUSINESS_QUESTION_PREFIX));
  assert.ok(mixed.verification_limitations.join().includes("仅有截图证据"));
  assert.deepEqual(mixed.validation_errors, []);
});

it("分流：证据缺口仍是校验缺项（自动重试），不能被当成环境限制", () => {
  const gap = parseInvestigation(JSON.stringify({ root_cause: "", evidence: [], planned_files: [], blocked_reasons: ["已找到 Map.ts，但未证实 OnClick 会进入预放置状态"] }));
  assert.deepEqual(gap.blocked_reasons, []);
  assert.ok(gap.validation_errors.join().includes("未证实"));
  assert.equal(isVerificationLimitation("已找到 Map.ts，但未证实 OnClick 会进入预放置状态"), false);
});

it("分流：业务问题+环境词仍算业务问题（可阻断）", () => {
  assert.equal(isVerificationLimitation("无法在游戏内验证地图ID应取哪个字段"), false);
  assert.equal(isVerificationLimitation("无法运行游戏验证"), true);
});

it("分流：基线不可确认 -> 人工出口，不是格式错误", () => {
  const parsed = parseInvestigation(JSON.stringify({
    root_cause: "现有代码疑似已包含该修复",
    evidence: ["[观察] Map.ts:60 已按地图ID比较", "[推断] 现有实现已覆盖该场景"],
    planned_files: ["Map.ts"],
    reproduction: { command: "", before: "" },
    blocked_reasons: ["基线不可确认：当前代码疑似已包含修复，无法复现修复前失败"],
  }));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.validation_errors, [], "不得因为缺 reproduction.before 而当格式错误重试");
  assert.ok(parsed.blocked_reasons.join().includes(BASELINE_UNCONFIRMED_PREFIX));
});

// ---------------------------------------------------------------------------
// 2) source_refs 精确错误
// ---------------------------------------------------------------------------
it("source_refs：空工单字段 / 越界 / 非 [观察] / 非法格式分别指出 ref 与原因", () => {
  const withRef = (ref, fields) => parseRepairContract(
    { ...contract, acceptance_cases: [{ ...contract.acceptance_cases[0], source_refs: [ref] }] }, evidence, fields,
  ).errors.join("\n");
  assert.ok(withRef("bug:expected_result", { expected_result: "" }).includes("bug:expected_result"));
  assert.ok(withRef("bug:expected_result", { expected_result: "" }).includes("为空"));
  assert.ok(withRef("evidence:9").includes("evidence:9") && withRef("evidence:9").includes("越界"));
  assert.ok(withRef("evidence:1").includes("evidence:1") && withRef("evidence:1").includes("[观察]"));
  assert.ok(withRef("file:Invented.ts").includes("格式非法"));
  assert.ok(parseRepairContract({ ...contract, domain_facts: [{ ...contract.domain_facts[0], source_refs: [] }] }, evidence).errors.join().includes("缺少 source_refs"));
  assert.deepEqual(parseRepairContract(contract, evidence).errors, []);
});

// ---------------------------------------------------------------------------
// 3) 断点与继续调查提示
// ---------------------------------------------------------------------------
it("checkpoint：open_questions 不混入 validation_errors，缺项单独进入继续调查提示", () => {
  const empty = parseInvestigation("");
  assert.ok(empty.validation_errors.length > 0);
  const checkpoint = captureInvestigationProgress("工具 read: Map.ts", empty);
  assert.deepEqual(checkpoint.open_questions, []);
  const prompt = buildInvestigationContinuationPrompt("TASK", checkpoint, empty.validation_errors);
  assert.ok(prompt.includes("上一轮未通过校验的项"));
  assert.ok(prompt.includes(empty.validation_errors[0]));
  assert.ok(prompt.includes("不是工单缺少信息"));
  assert.ok(!buildInvestigationContinuationPrompt("TASK", checkpoint).includes("上一轮未通过校验的项"));
});

it("checkpoint：验证限制随断点保留，不静默丢失", () => {
  const first = captureInvestigationProgress("工具 read: Map.ts", investigationOf({
    repair_contract: contract, verification_limitations: ["无法运行游戏，仅有截图证据"],
  }));
  const carried = captureInvestigationProgress("工具 read: Click.ts", parseInvestigation(""), first);
  assert.ok(carried.verification_limitations.join().includes("无法运行游戏"));
});

// ---------------------------------------------------------------------------
// 4) 调查提示不再要求不可用的 p4/git shell
// ---------------------------------------------------------------------------
it("调查提示：明确沙箱无 shell / 无 p4 / 无 git，且不再要求历史命令", () => {
  const prompt = buildInvestigationPrompt(bug, "app", "C:\\repo");
  assert.ok(prompt.includes("不提供 shell"));
  assert.ok(prompt.includes("p4 与 git 命令都不可用"));
  assert.ok(!prompt.includes("p4 filelog"));
  assert.ok(!prompt.includes("p4 annotate"));
  assert.ok(!prompt.includes('git -C "根的绝对路径"'));
  assert.ok(prompt.includes("verification_limitations"));
  assert.ok(prompt.includes("基线不可确认"));
  assert.ok(prompt.includes("会转人工补充"));
});

// ---------------------------------------------------------------------------
// 5) 截图场景：限制必须在实施提示 / 评审提示 / 交付描述中如实出现
// ---------------------------------------------------------------------------
it("截图场景：只有截图证据、无法运行游戏时，修复照常推进且限制全程可见", () => {
  const limitation = "无法运行游戏，仅能依据工单截图与静态代码证据";
  const investigation = parseInvestigation(JSON.stringify({
    root_cause: "标记绘制条件用资源路径比较",
    evidence: ["[观察] 工单截图:标记消失", "[观察] Map.ts:60 使用资源路径比较", "[推断] 路径相同但地图ID不同的场景被误判"],
    reproduction: { command: "", before: "无法运行游戏复现，仅有截图证据" },
    planned_files: ["Map.ts"],
    verification_limitations: [limitation],
    repair_contract: contract,
  }));
  assert.equal(investigation.ok, true, "纯验证限制不能阻断");
  assert.ok(investigation.verification_limitations.includes(limitation));
  assert.ok(investigation.verification_limitations.includes("无法运行游戏复现，仅有截图证据"), "reproduction.before 中的限制也要登记");

  const implPrompt = buildImplementationPrompt({
    bug, repoName: "app", repoPath: "C:\\repo",
    verifyCommands: ["npm run typecheck"], investigation, retryEvidence: "", reviewerFeedback: "",
  });
  assert.ok(implPrompt.includes("# 验证限制"));
  assert.ok(implPrompt.includes(limitation));
  assert.ok(implPrompt.includes("禁止当成已验证"));
  assert.ok(!implPrompt.includes("修复前失败现象: 无法运行游戏复现"), "限制不得被当成修复前失败现象展示");

  const reviewPrompt = buildReviewPrompt({
    bug, investigation, diff: "- old\n+ new", verificationSummary: "npm run typecheck 通过",
  });
  assert.ok(reviewPrompt.includes("# 已登记的验证限制"));
  assert.ok(reviewPrompt.includes(limitation));
  assert.ok(reviewPrompt.includes("unverified_items"));

  const desc = buildDescription(bug, {
    ok: true, summary: "按地图ID比较", changed_files: ["project:Map.ts"], manual_assets: [],
    blocked_reasons: [], exit_code: 0, log: "", raw_output: "",
  }, "npm run typecheck 通过", [
    "本 changelist 由 TapdBugFixAgent 自动生成，请人工 review 后提交",
    ...investigation.verification_limitations.map((item) => `验证限制（未执行/无法执行，不得视为已通过）: ${item}`),
  ]);
  assert.ok(desc.includes("验证限制（未执行/无法执行，不得视为已通过）"));
  assert.ok(desc.includes(limitation));
  assert.ok(!/验证[:：][\s\S]*已通过运行时/.test(desc));
});

it("截图场景：限制与验证结果并存时，不得把限制写成已验证", () => {
  const investigation = parseInvestigation(JSON.stringify({
    ...base,
    reproduction: { command: "", before: "无法运行游戏复现" },
    verification_limitations: ["缺少可运行的客户端环境，无法做端到端验证"],
    repair_contract: contract,
  }));
  const reviewPrompt = buildReviewPrompt({ bug, investigation, diff: "d", verificationSummary: "npm test 通过" });
  assert.ok(reviewPrompt.includes("必须逐条出现在 unverified_items"));
  assert.ok(reviewPrompt.includes("不得改写成已通过"));
});

// ---------------------------------------------------------------------------
// 6) 编排链路：分流在真实 Worker 上生效（尝试次数、交付描述、评审输入）
// ---------------------------------------------------------------------------
const tmpdirs = [];
const originalRun = PiAgent.prototype.run;
const originalP4 = {
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
  PiAgent.prototype.run = originalRun;
  Object.assign(P4Client.prototype, originalP4);
}

function makeBug(over = {}) {
  return bugFromDict({
    id: "1123456780001234007",
    workspace_id: "1123456780",
    title: "自定义标记跨地图传送未拦截",
    description: "玩家地图ID与标记地图ID不同时仍会发起传送请求，预期应提示并不发送请求。复现步骤：1. 在A地图添加标记 2. 切到B地图点击传送。",
    priority: "1", severity: "严重", module: "map", reporter: "tester", created: "2026-09-01 10:00:00",
    ...over,
  }, "1123456780");
}

function makeResult(over = {}) {
  return { ok: true, summary: "", changed_files: [], manual_assets: [], blocked_reasons: [], exit_code: 0, log: "", raw_output: "", ...over };
}

function makeWorker(repoDir) {
  const store = new StateStore(":memory:");
  const cfg = {
    max_bugs_per_run: 10, max_attempts: 2, agent_timeout_s: 900, mcp_servers: {},
    quality: {
      admission: { min_score: 0, require_reproduction_signal: false, manual_keywords: [] },
      require_verification: false, max_changed_files: 8, max_diff_lines: 500,
    },
    review: { enabled: false, max_fix_rounds: 0 },
    exclude_status: ["resolved", "closed", "rejected"],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [{ workspace_id: "111", owner: "me", repos: [{ name: "r", path: repoDir, verify_cmds: [] }], default_repo: "" }],
    pi: { provider: undefined }, p4: {}, web: {}, tapd: {}, config_path: "",
  };
  const worker = new Worker(cfg, store);
  // 工单 workspace_id 决定取用哪个客户端；这里让两者都能命中同一个假客户端。
  const fake = { addComment: async () => {}, updateBug: async () => {} };
  worker.clients["111"] = fake;
  worker.clients["1123456780"] = fake;
  worker.fetchMyBugs = async () => worker.__bugs ?? [];
  return worker;
}

function installP4(opened = []) {
  P4Client.prototype.sync = async () => "";
  P4Client.prototype.edit = async () => "";
  P4Client.prototype.revertUnchanged = async () => "";
  P4Client.prototype.reconcilePreview = async () => "";
  P4Client.prototype.reconcile = async () => "";
  P4Client.prototype.diffUnified = async () => "--- a/Map.ts\n+++ b/Map.ts\n-old\n+fixed";
  P4Client.prototype.createPending = async () => 4321;
  P4Client.prototype.revert = async () => "";
  let openedCalls = 0;
  P4Client.prototype.opened = async () => {
    openedCalls += 1;
    return openedCalls === 1 ? [] : opened;
  };
}

function makeRepoDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-contract-probe-"));
  tmpdirs.push(dir);
  fs.writeFileSync(path.join(dir, "Map.ts"), "export const compare = (a: string, b: string) => a === b;\n");
  return dir;
}

const DEPOT_MAP = { depot: "//depot/Map.ts", action: "edit", changelist: "default", type: "text" };
const CONTRACT_JSON = JSON.stringify({
  acceptance_cases: [{ given: "标记地图ID与玩家地图ID不同", when: "点击传送", then: "显示提示且不发送传送请求", source_refs: ["evidence:0"] }],
  preserved_behaviors: ["同地图可正常传送"],
  domain_facts: [{ concept: "MapId", meaning: "地图业务标识，与资源路径不等价", source_refs: ["evidence:0"] }],
  reuse_options: [{ symbol: "OnGotoClick", action: "reuse", reason: "沿用同地图传送链" }],
  open_questions: [],
});
const investigationOutput = (over = {}) => `FINAL_RESULT: ${JSON.stringify({
  repair_contract: JSON.parse(CONTRACT_JSON),
  root_cause: "传送校验用资源路径比较",
  evidence: ["[观察] Map.ts:1 使用资源路径比较", "[推断] 路径相同但地图ID不同时误放行"],
  reproduction: { command: "npm test -- map", before: "跨地图仍发送请求" },
  planned_files: ["Map.ts"],
  confidence: 0.9,
  blocked_reasons: [],
  ...over,
})}`;

async function runScenario({ results, opened = [DEPOT_MAP], repoDir }) {
  restorePrototypes();
  const worker = makeWorker(repoDir);
  const bug = makeBug();
  worker.__bugs = [bug];
  const calls = [];
  installP4(opened);
  PiAgent.prototype.run = async (opts) => {
    calls.push(opts);
    return results[calls.length - 1](opts);
  };
  await worker.processBug(bug);
  restorePrototypes();
  return { worker, bug, calls };
}

it("链路：业务未决问题 -> needs_info，不消耗修复尝试次数，也不会调用实施 Agent", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [() => makeResult({ raw_output: investigationOutput({
      repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
    }) })],
  });
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "needs_info");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 0, "人工出口不得消耗修复重试");
  assert.equal(calls.length, 1, "只调用只读调查一次：不进入补充核查/实施");
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes(BUSINESS_QUESTION_PREFIX));
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("不消耗修复尝试次数"));
});

it("人工出口不会被启动对账自动放回队列（无死循环）", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug } = await runScenario({
    repoDir,
    results: [() => makeResult({ raw_output: investigationOutput({
      repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
    }) })],
  });
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "needs_info");
  worker.reconcileStaleInProgress();
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "needs_info", "业务问题的 needs_info 不得被启动对账放回队列");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 0);
});

it("链路：基线不可确认 -> needs_info（人工出口），不按格式错误重试", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [() => makeResult({ raw_output: investigationOutput({
      root_cause: "现有代码疑似已包含该修复",
      reproduction: { command: "", before: "" },
      blocked_reasons: ["基线不可确认：当前代码疑似已包含地图ID比较，无法复现修复前失败"],
    }) })],
  });
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "needs_info");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 0);
  assert.equal(calls.length, 1);
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes(BASELINE_UNCONFIRMED_PREFIX));
});

it("链路：纯验证限制（截图场景）不阻断，限制进入实施/评审输入与交付描述", async () => {
  const repoDir = makeRepoDir();
  const limitation = "无法运行游戏，仅能依据工单截图与静态证据验证";
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [
      () => makeResult({ raw_output: investigationOutput({
        reproduction: { command: "", before: "无法运行游戏复现，仅有截图证据" },
        verification_limitations: [limitation],
      }) }),
      () => makeResult({ changed_files: ["project:Map.ts"], summary: "改用地图ID比较；剩余限制：无法运行游戏验证" }),
    ],
  });
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "candidate", "纯验证限制不得阻断修复");
  assert.equal(calls.length, 2, "调查后正常进入实施");
  assert.ok(calls[1].prompt.includes(limitation), "实施提示必须携带验证限制");
  assert.ok(calls[1].prompt.includes("禁止当成已验证"));
  const desc = String(worker.store.getJob(bug.id)?.generated_description ?? "");
  assert.ok(desc.includes("验证限制（未执行/无法执行，不得视为已通过）"), "交付描述必须如实保留限制");
  assert.ok(desc.includes(limitation));
  const candidate = worker.store.audit.candidates(bug.id).at(-1);
  assert.ok(candidate.evidence.verification_limitations.includes(limitation), "审计证据必须保留限制");
  const finished = worker.store.audit.attempts(bug.id).at(-1).events.find((event) => event.kind === "finished");
  assert.ok(finished.payload.verification_limitations.includes(limitation));
});

it("链路：启用评审时限制进入评审提示，并要求列入 unverified_items", async () => {
  const repoDir = makeRepoDir();
  const limitation = "无法运行游戏内端到端验证";
  restorePrototypes();
  const worker = makeWorker(repoDir);
  worker.config.review.enabled = true;
  worker.config.max_attempts = 1;
  // 评审只在机器验证通过后运行：探针用假子进程回放 exit 0，其余仍是真实编排逻辑。
  worker.config.workspaces[0].repos[0].verify_cmds = ['node -e "process.exit(0)"'];
  const bug = makeBug();
  worker.__bugs = [bug];
  installP4([DEPOT_MAP]);
  const calls = [];
  PiAgent.prototype.run = async (opts) => {
    calls.push(opts);
    if (calls.length === 1) return makeResult({ raw_output: investigationOutput({ verification_limitations: [limitation] }) });
    if (calls.length === 2) return makeResult({ changed_files: ["project:Map.ts"], summary: "改用地图ID比较" });
    return makeResult({ raw_output: 'FINAL_RESULT: {"approved":true,"requirement_match":"pass","behavioral_evidence":"static_only","reuse_and_lifecycle":"pass","unverified_items":["无法运行游戏内端到端验证"],"note":"静态证据充分","findings":[]}' });
  };
  await worker.processBug(bug);
  restorePrototypes();
  const reviewCall = calls.find((call) => call.role === "review");
  assert.ok(reviewCall, "必须调用评审 Agent");
  assert.ok(reviewCall.prompt.includes(limitation));
  assert.ok(reviewCall.prompt.includes("必须逐条出现在 unverified_items"));
});

it("链路：实施 Agent 把“无法运行游戏”写进 blocked_reasons 时，登记为验证限制而不是判失败重试", async () => {
  const repoDir = makeRepoDir();
  const limitation = "无法运行游戏内验证传送提示";
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [
      () => makeResult({ raw_output: investigationOutput() }),
      () => makeResult({ changed_files: ["project:Map.ts"], summary: "改用地图ID比较", blocked_reasons: [limitation] }),
    ],
  });
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "candidate", "纯验证限制不得让实施判失败");
  assert.equal(calls.length, 2, "不得因此重试实施阶段");
  const stored = JSON.parse(String(worker.store.getJob(bug.id)?.investigation));
  assert.ok(stored.verification_limitations.includes(limitation));
  const desc = String(worker.store.getJob(bug.id)?.generated_description ?? "");
  assert.ok(desc.includes(limitation));
});

it("链路：只读范围补充轮不会丢掉已登记的验证限制", async () => {
  const repoDir = makeRepoDir();
  fs.mkdirSync(path.join(repoDir, "View"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "View", "Extra.ts"), "export const helper = 1;\n");
  const limitation = "无法运行游戏，仅能依据截图验证";
  const { worker, bug, calls } = await runScenario({
    repoDir,
    opened: [DEPOT_MAP, { depot: "//depot/View/Extra.ts", action: "edit", changelist: "default", type: "text" }],
    results: [
      () => makeResult({ raw_output: investigationOutput({
        verification_limitations: [limitation],
        scope_amendment: { files: ["View/Extra.ts"], reason: "复用既有辅助函数" },
      }) }),
      // 范围补充轮只加文件，且没有重复声明限制
      () => makeResult({ raw_output: investigationOutput({ planned_files: ["Map.ts", "View/Extra.ts"] }) }),
      () => makeResult({ changed_files: ["project:Map.ts", "project:View/Extra.ts"], summary: "按范围补充修复" }),
    ],
  });
  assert.equal(calls.length, 3, "范围补充只允许一轮");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "candidate");
  const stored = JSON.parse(String(worker.store.getJob(bug.id)?.investigation));
  assert.ok(stored.planned_files.includes("View/Extra.ts"));
  assert.ok(stored.verification_limitations.includes(limitation), "限制不得在范围补充轮静默丢失");
  assert.ok(String(worker.store.getJob(bug.id)?.generated_description).includes(limitation));
});

it("链路：继续调查提示收到上一轮 validation_errors，断点 open_questions 不混入校验缺项", async () => {
  const repoDir = makeRepoDir();
  restorePrototypes();
  const worker = makeWorker(repoDir);
  worker.config.max_attempts = 3;
  const bug = makeBug();
  worker.__bugs = [bug];
  installP4([]);
  const incomplete = () => makeResult({ raw_output: `FINAL_RESULT: ${JSON.stringify({
    repair_contract: JSON.parse(CONTRACT_JSON),
    root_cause: "", evidence: ["[观察] Map.ts:1 资源路径比较"], planned_files: [],
    blocked_reasons: ["未读取标记创建调用者"],
  })}` });
  const calls = [];
  PiAgent.prototype.run = async (opts) => { calls.push(opts); return incomplete(); };
  await worker.processBug(bug);
  const saved = JSON.parse(String(worker.store.getJob(bug.id)?.retry_evidence))[0];
  assert.ok(saved.investigation.validation_errors.join().includes("未读取标记创建调用者"));
  assert.ok(!saved.investigation_progress.open_questions.join().includes("调查证据尚未收敛"));

  calls.length = 0;
  PiAgent.prototype.run = async (opts) => { calls.push(opts); throw new Error("探针结束"); };
  await worker.processBug(bug);
  restorePrototypes();
  const resumed = calls[0].prompt;
  assert.ok(resumed.includes("# 继续未完成调查"));
  assert.ok(resumed.includes("上一轮未通过校验的项"));
  assert.ok(resumed.includes("未读取标记创建调用者"));
  assert.ok(resumed.includes("不是工单缺少信息"));
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

