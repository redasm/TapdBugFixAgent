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
  INVESTIGATION_UNCONVERGED_PREFIX,
  WORKSPACE_SAFETY_BLOCK_GUIDANCE,
  buildImplementationPrompt,
  buildInvestigationContinuationPrompt,
  buildInvestigationPrompt,
  isWorkspaceSafetyReason,
  parseInvestigation,
} = await import("../dist/repairWorkflow.js");
const { parseRepairContract, isVerificationLimitation } = await import("../dist/repairContract.js");
const { captureInvestigationProgress } = await import("../dist/investigationProgress.js");
const { buildReviewPrompt } = await import("../dist/review.js");
const { buildDescription } = await import("../dist/descgen.js");
const { bugFromDict } = await import("../dist/models.js");
const { Worker, isLegacyInvestigationNeedsInfo } = await import("../dist/worker.js");
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
it("分流：业务未决问题 -> 调查未收敛校验缺项（补查+自动重试），不是人工出口", () => {
  const parsed = investigationOf({ repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] } });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.blocked_reasons, [], "调查阶段不得再有业务问题的人工出口");
  assert.ok(parsed.validation_errors.join().includes(INVESTIGATION_UNCONVERGED_PREFIX), "必须走补查+自动重试的校验缺项");
  assert.ok(parsed.validation_errors.join().includes("玩家地图ID具体来自哪个字段？"));
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

it("分流：业务问题与验证限制并存时，问题转补查缺口、限制保留", () => {
  const mixed = investigationOf({
    repair_contract: { ...contract, open_questions: ["玩家地图ID具体来自哪个字段？"] },
    verification_limitations: ["无法运行游戏，仅有截图证据"],
  });
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.blocked_reasons, []);
  assert.ok(mixed.validation_errors.join().includes(INVESTIGATION_UNCONVERGED_PREFIX));
  assert.ok(mixed.verification_limitations.join().includes("仅有截图证据"));
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

it("分流：基线不可确认 -> 调查未收敛校验缺项，不是人工出口", () => {
  const parsed = parseInvestigation(JSON.stringify({
    root_cause: "现有代码疑似已包含该修复",
    evidence: ["[观察] Map.ts:60 已按地图ID比较", "[推断] 现有实现已覆盖该场景"],
    planned_files: ["Map.ts"],
    reproduction: { command: "", before: "" },
    blocked_reasons: ["基线不可确认：当前代码疑似已包含修复，无法复现修复前失败"],
  }));
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.blocked_reasons, []);
  assert.ok(parsed.validation_errors.join().includes(INVESTIGATION_UNCONVERGED_PREFIX));
  assert.ok(parsed.validation_errors.join().includes("基线不可确认"), "原因原文必须保留供补查");
});

it("分流：只有真正的工作区/权限阻塞才是调查阶段的人工出口", () => {
  const blocked = parseInvestigation(JSON.stringify({
    root_cause: "", evidence: [], planned_files: [],
    blocked_reasons: ["目标不在允许访问的工作目录中", "存在安全风险，无法在当前工作区内进行最小修改"],
  }));
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blocked_reasons, [
    "目标不在允许访问的工作目录中",
    "存在安全风险，无法在当前工作区内进行最小修改",
  ]);
  assert.deepEqual(blocked.validation_errors, []);
  assert.equal(isWorkspaceSafetyReason("目标不在允许访问的工作目录中"), true);
  assert.equal(isWorkspaceSafetyReason("基线不可确认：无法复现修复前失败"), false);
  assert.equal(isWorkspaceSafetyReason("无法根据标题、描述及现有代码定位问题"), false);
});

it("分流：四类普通证据陈述不得被误判为安全阻塞，四类明确安全结论必须阻塞", () => {
  const positives = [
    "目标修改路径不在允许访问的工作目录内",
    "目标仓库不在允许范围内",
    "当前工作区缺少写权限，无法读取或写入目标文件",
    "目标仓库无修改权限，无法写入",
    "无法在当前工作区安全修改目标文件",
    "存在安全风险，无法在当前工作区内进行最小修改",
    "无法安全选择目标仓库或修改位置",
  ];
  const negatives = [
    "未确认该改动是否存在安全风险",
    "证据缺口：无法读取工作区之外的外部依赖版本",
    "该符号定义在 project 工作区之外的同名模块中，未能核对",
    "Bug 所属仓库无法判断",
  ];
  for (const reason of positives) assert.equal(isWorkspaceSafetyReason(reason), true, reason);
  for (const reason of negatives) assert.equal(isWorkspaceSafetyReason(reason), false, reason);

  // 反例必须走补查缺口，而不是人工出口
  const gaps = investigationOf({ repair_contract: contract, blocked_reasons: negatives });
  assert.equal(gaps.ok, false);
  assert.deepEqual(gaps.blocked_reasons, []);
  for (const reason of negatives) {
    assert.ok(gaps.validation_errors.join().includes(reason), reason);
  }
  assert.ok(gaps.validation_errors.join().includes(INVESTIGATION_UNCONVERGED_PREFIX));

  // 混合原因：安全阻塞保留，普通缺口不得被静默丢掉（保留在 validation_errors 供展示）
  const mixed = parseInvestigation(JSON.stringify({
    root_cause: "", evidence: [], planned_files: [],
    blocked_reasons: [
      "目标修改路径不在允许访问的工作目录内",
      "该符号定义在 project 工作区之外的同名模块中，未能核对",
    ],
  }));
  assert.deepEqual(mixed.blocked_reasons, ["目标修改路径不在允许访问的工作目录内"]);
  assert.ok(mixed.validation_errors.join().includes("该符号定义在 project 工作区之外的同名模块中"));

  // 提示词与解析器一致：提示里推荐的每条措辞都必须能被解析器认成安全阻塞
  const prompt = buildInvestigationPrompt(bug, "app", "C:\\repo");
  for (const item of WORKSPACE_SAFETY_BLOCK_GUIDANCE) {
    assert.ok(prompt.includes(item), item);
    const example = item.match(/例：([^）]+)/)?.[1];
    assert.ok(example, item);
    assert.equal(isWorkspaceSafetyReason(example), true, example);
  }
  assert.ok(prompt.includes("Bug 所属仓库无法判断"));
  assert.ok(prompt.includes("不构成阻塞"));
});

it("分流：基线不可确认原文不得当 reproduction.before（保持未收敛，自动补查/重试）", () => {
  const parsed = parseInvestigation(JSON.stringify({
    ...base,
    repair_contract: contract,
    reproduction: { command: "npm test -- map", before: "基线不可确认：当前代码疑似已包含修复，无法复现修复前失败" },
  }));
  assert.equal(parsed.ok, false, "基线不可确认文本不能让调查判为已收敛");
  assert.deepEqual(parsed.blocked_reasons, []);
  assert.ok(parsed.validation_errors.join().includes(INVESTIGATION_UNCONVERGED_PREFIX));
  assert.ok(parsed.validation_errors.join().includes("不能当作真实失败基线"));

  const implPrompt = buildImplementationPrompt({
    bug, repoName: "app", repoPath: "C:\\repo", verifyCommands: [],
    investigation: { ...parsed, ok: true }, retryEvidence: "", reviewerFeedback: "",
  });
  assert.ok(!implPrompt.includes("修复前失败现象: 基线不可确认"), "这类原文不得作为修复前失败现象喂给实施");
  assert.ok(implPrompt.includes("修复前失败现象: （调查阶段未确认可核查的修复前失败现象"));

  // 真实观察到的失败仍可正常作为 before
  const real = investigationOf({ repair_contract: contract, reproduction: { command: "npm test -- map", before: "FAIL Map.spec.ts: 跨地图仍发送请求" } });
  assert.equal(real.ok, true);
  assert.deepEqual(real.validation_errors, []);
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

it("checkpoint：声明的证据缺口走 validation_errors，不再进 open_questions", () => {
  const parsed = parseInvestigation(JSON.stringify({
    root_cause: "", evidence: ["[观察] Map.ts:40 调用 enterPlacement"], planned_files: [],
    blocked_reasons: ["未证实边缘点击是否调用 enterPlacement"],
  }));
  assert.deepEqual(parsed.blocked_reasons, []);
  assert.ok(parsed.validation_errors.join(" ").includes("未证实边缘点击"));
  const checkpoint = captureInvestigationProgress("工具 read: Map.ts", parsed);
  assert.deepEqual(checkpoint.open_questions, [], "缺口不再是业务未决问题，也不进断点");
  assert.ok(checkpoint.findings.join(" ").includes("Map.ts:40"), "已有观察必须保留");
  const prompt = buildInvestigationContinuationPrompt("TASK", checkpoint, parsed.validation_errors);
  assert.ok(prompt.includes("未证实边缘点击"), "缺口必须通过校验缺项小节传给继续调查");
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
  assert.ok(prompt.includes("不得因此要求人工确认"));
  assert.ok(prompt.includes("耗尽后 failed"));
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

it("链路：业务未决问题先走补充调查；补查收敛后进入实施，不会转 needs_info", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [
      () => makeResult({ raw_output: investigationOutput({
        repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
      }) }),
      // 补充调查轮把业务条件按工单+源码收敛成可验证结论
      () => makeResult({ raw_output: investigationOutput() }),
      () => makeResult({ changed_files: ["project:Map.ts"], summary: "改用地图ID比较" }),
    ],
  });
  assert.equal(calls.length, 3, "调查 → 定向补查 → 实施，不被 needs_info 中断");
  assert.deepEqual(calls[1].tools, ["read", "grep", "find", "ls"], "第二轮必须是只读补充调查");
  assert.ok(calls[1].prompt.includes(INVESTIGATION_UNCONVERGED_PREFIX), "补查提示必须带上未收敛缺口");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "candidate");
});

it("链路：未收敛调查不会被启动对账改写成人工出口", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug } = await runScenario({
    repoDir,
    results: [
      () => makeResult({ raw_output: investigationOutput({
        repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
      }) }),
      () => makeResult({ raw_output: investigationOutput({
        repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
      }) }),
    ],
  });
  const state = worker.store.getJob(bug.id)?.agent_state;
  assert.notEqual(state, "needs_info", "调查阶段不得再有 needs_info 出口");
  assert.equal(state, "pending", "普通失败 → 待自动重试");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 1);
  worker.reconcileStaleInProgress();
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "pending");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 1);
});

it("链路：基线不可确认 -> 普通失败自动重试，不按人工出口处理", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [
      () => makeResult({ raw_output: investigationOutput({
        root_cause: "现有代码疑似已包含该修复",
        reproduction: { command: "", before: "" },
        blocked_reasons: ["基线不可确认：当前代码疑似已包含地图ID比较，无法复现修复前失败"],
      }) }),
      () => makeResult({ raw_output: investigationOutput({
        root_cause: "现有代码疑似已包含该修复",
        reproduction: { command: "", before: "" },
        blocked_reasons: ["基线不可确认：当前代码疑似已包含地图ID比较，无法复现修复前失败"],
      }) }),
    ],
  });
  assert.equal(calls.length, 2, "主调查 + 一轮定向补查，不做人工确认");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "pending");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 1);
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("基线不可确认"));
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes(INVESTIGATION_UNCONVERGED_PREFIX));
});

it("链路：reproduction.before 写成「基线不可确认」时保持未收敛，不喂给实施当失败现象", async () => {
  const repoDir = makeRepoDir();
  const unconfirmedBefore = () => makeResult({ raw_output: investigationOutput({
    root_cause: "现有代码疑似已包含该修复",
    reproduction: { command: "npm test -- map", before: "基线不可确认：当前代码疑似已包含地图ID比较，无法复现修复前失败" },
  }) });
  const { worker, bug, calls } = await runScenario({ repoDir, results: [unconfirmedBefore, unconfirmedBefore] });
  assert.equal(calls.length, 2, "主调查 + 一轮定向补查，不得直接进入实施阶段");
  const job = worker.store.getJob(bug.id);
  assert.equal(job?.agent_state, "pending");
  assert.equal(Number(job?.attempts ?? 0), 1);
  assert.ok(String(job?.failure_reason).includes("不能当作真实失败基线"));
  assert.ok(String(job?.failure_reason).includes(INVESTIGATION_UNCONVERGED_PREFIX));
  for (const call of calls) {
    assert.ok(!String(call.prompt).includes("修复前失败现象: 基线不可确认"), "这类原文不得作为修复前失败现象");
  }
});

it("链路：安全阻塞与普通缺口混合时阻塞照旧，缺口保留在失败原因里", async () => {
  const repoDir = makeRepoDir();
  const blocked = () => makeResult({ raw_output: `FINAL_RESULT: ${JSON.stringify({
    repair_contract: null, root_cause: "", evidence: [], planned_files: [],
    blocked_reasons: [
      "目标修改路径不在允许访问的工作目录内",
      "该符号定义在 project 工作区之外的同名模块中，未能核对",
    ],
  })}` });
  const { worker, bug, calls } = await runScenario({ repoDir, results: [blocked] });
  assert.equal(calls.length, 1, "有安全阻塞就不做补查（交人工处理）");
  const job = worker.store.getJob(bug.id);
  assert.equal(job?.agent_state, "blocked_workspace");
  assert.equal(Number(job?.attempts ?? 0), 0);
  const reason = String(job?.failure_reason ?? "");
  assert.ok(reason.includes("目标修改路径不在允许访问的工作目录内"));
  assert.ok(reason.includes("调查证据尚未收敛"), "混合原因里的普通缺口必须保留供展示");
  assert.ok(reason.includes("该符号定义在 project 工作区之外的同名模块中"));
});

it("链路：无法定位代码入口同样走补查与自动重试，不转 needs_info", async () => {
  const repoDir = makeRepoDir();
  const unlocatable = () => makeResult({ raw_output: `FINAL_RESULT: ${JSON.stringify({
    repair_contract: JSON.parse(CONTRACT_JSON),
    root_cause: "", evidence: [], planned_files: [],
    blocked_reasons: ["无法根据标题、描述及现有代码定位问题"],
  })}` });
  const { worker, bug, calls } = await runScenario({ repoDir, results: [unlocatable, unlocatable] });
  assert.equal(calls.length, 2, "主调查 + 一轮定向补查");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "pending");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 1);
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes(INVESTIGATION_UNCONVERGED_PREFIX));
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("无法根据标题"));
});

it("链路：重试耗尽后判 failed，仍不进入人工出口", async () => {
  const repoDir = makeRepoDir();
  const neverConverges = () => makeResult({ raw_output: investigationOutput({
    repair_contract: { ...JSON.parse(CONTRACT_JSON), open_questions: ["标记地图ID与玩家地图ID分别来自哪个配置字段？"] },
  }) });
  restorePrototypes();
  const worker = makeWorker(repoDir);
  worker.config.max_attempts = 1;
  const bug = makeBug();
  worker.__bugs = [bug];
  installP4([]);
  const calls = [];
  PiAgent.prototype.run = async (opts) => { calls.push(opts); return neverConverges(); };
  await worker.processBug(bug);
  restorePrototypes();
  assert.equal(calls.length, 2, "仍先做一轮定向补查");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "failed");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 1);
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes(INVESTIGATION_UNCONVERGED_PREFIX));
});

it("链路：只有真正的工作区/权限阻塞才转 blocked_workspace（不消耗修复尝试）", async () => {
  const repoDir = makeRepoDir();
  const { worker, bug, calls } = await runScenario({
    repoDir,
    results: [() => makeResult({ raw_output: `FINAL_RESULT: ${JSON.stringify({
      repair_contract: null, root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: ["目标不在允许访问的工作目录中"],
    })}` })],
  });
  assert.equal(calls.length, 1, "工作区阻塞不做补查，也不转 needs_info");
  assert.equal(worker.store.getJob(bug.id)?.agent_state, "blocked_workspace");
  assert.equal(Number(worker.store.getJob(bug.id)?.attempts ?? 0), 0);
  assert.ok(String(worker.store.getJob(bug.id)?.failure_reason).includes("目标不在允许访问的工作目录中"));
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
// 7) 旧 needs_info 迁移：只恢复旧调查出口，精确、幂等、两条启动路径
// ---------------------------------------------------------------------------
it("迁移判定：只认旧调查出口的固定外壳，绝不命中准入层原因", () => {
  assert.equal(isLegacyInvestigationNeedsInfo("只读 Agent 明确无法定位问题: 无法根据标题、描述及现有代码定位问题"), true);
  assert.equal(isLegacyInvestigationNeedsInfo("只读 Agent 明确无法定位问题:无法定位相关模块"), true, "冒号后空格差异不影响");
  assert.equal(isLegacyInvestigationNeedsInfo("只读调查无法在无人工确认的情况下继续（不消耗修复尝试次数）: 业务条件尚未确认: 标记地图ID来自哪个字段？"), true);
  assert.equal(isLegacyInvestigationNeedsInfo("只读调查无法在无人工确认的情况下继续（不消耗修复尝试次数）: 基线不可确认（代码疑似已包含修复，需人工确认）: 现有代码疑似已包含修复"), true);
  assert.equal(isLegacyInvestigationNeedsInfo("只读 Agent 明确无法定位问题"), false, "不带冒号与正文的同名短语不是旧外壳");
  assert.equal(isLegacyInvestigationNeedsInfo("只读调查无法在无人工确认的情况下继续（不消耗修复尝试次数）: 其它缺口"), false);
  assert.equal(isLegacyInvestigationNeedsInfo("问题描述过短；缺少复现步骤或可复现信号；缺少预期结果"), false);
  assert.equal(isLegacyInvestigationNeedsInfo("涉及需人工处理的资源或工具: 协议"), false);
  assert.equal(isLegacyInvestigationNeedsInfo("Agent 调用超时(1800s): pi"), false);
  assert.equal(isLegacyInvestigationNeedsInfo(""), false);
});

it("迁移：只恢复旧调查出口误标的 needs_info，不碰准入层与已有产物（幂等、不解除冷却）", async () => {
  const repoDir = makeRepoDir();
  const worker = makeWorker(repoDir);
  const HUMAN_SHELL = "只读调查无法在无人工确认的情况下继续（不消耗修复尝试次数）: ";
  const legacy = (id, failure_reason, extra = {}) => {
    const old = bugFromDict({ id, name: "历史 needs_info 任务", description: "描述" }, "111");
    worker.store.upsertJob(old, {
      agent_state: "needs_info", failure_reason, finished_at: "2026-09-03 21:00:00", ...extra,
    });
    return old;
  };
  const unlocatable = legacy("1123456780001254400", "只读 Agent 明确无法定位问题: 无法根据标题、描述及现有代码定位问题");
  const business = legacy("1123456780001254401", `${HUMAN_SHELL}业务条件尚未确认: 标记地图ID来自哪个字段？`);
  const baseline = legacy("1123456780001254402", `${HUMAN_SHELL}基线不可确认（代码疑似已包含修复，需人工确认）: 当前代码疑似已包含修复`);
  const admission = legacy("1123456780001254403", "问题描述过短；缺少复现步骤或可复现信号；缺少预期结果");
  const noColonShell = legacy("1123456780001254404", "只读 Agent 明确无法定位问题");
  const withCandidate = legacy("1123456780001254405", "只读 Agent 明确无法定位问题: 无法定位相关模块", { changelist: 822967 });
  const spentAttempts = legacy("1123456780001254406", "只读 Agent 明确无法定位问题: 无法定位相关模块", { attempts: 1 });
  worker.store.setProviderCooldown({ until_ms: Date.now() + 600_000, kind: "quota", reason: "额度", failures: 2 });

  assert.equal(worker.recoverLegacyInvestigationNeedsInfo(), 3, "只恢复三类旧调查出口");
  for (const restored of [unlocatable, business, baseline]) {
    assert.equal(worker.store.getJob(restored.id)?.agent_state, "pending");
    assert.equal(worker.store.getJob(restored.id)?.failure_reason, null);
    assert.equal(worker.store.getJob(restored.id)?.finished_at, null);
    assert.ok(worker.store.listEvents(restored.id).some((e) => String(e.msg).includes("原失败原因")), "必须留审计事件");
  }
  for (const untouched of [admission, noColonShell, withCandidate, spentAttempts]) {
    assert.equal(worker.store.getJob(untouched.id)?.agent_state, "needs_info", untouched.id);
  }
  assert.equal(worker.store.getJob(withCandidate.id)?.changelist, 822967);
  assert.notEqual(worker.store.activeProviderCooldown(), null, "迁移不得解除 provider 全局冷却");
  assert.equal(worker.recoverLegacyInvestigationNeedsInfo(), 0, "幂等：重复调用不再恢复");

  // runBatch 启动路径同样执行迁移（limit=0 只跑启动对账，不领取任务）
  const viaBatch = legacy("1123456780001254407", "只读 Agent 明确无法定位问题: 未找到相关模块");
  assert.equal(await worker.runBatch(0), 0);
  assert.equal(worker.store.getJob(viaBatch.id)?.agent_state, "pending");

  // runLoop 启动路径同样执行迁移
  const viaLoop = legacy("1123456780001254408", "只读 Agent 明确无法定位问题: 未找到相关代码入口");
  worker.startLoop();
  await worker.shutdown();
  assert.equal(worker.store.getJob(viaLoop.id)?.agent_state, "pending");
});

it("迁移：单次限流 5 个，剩余任务由后续启动继续迁移", () => {
  const repoDir = makeRepoDir();
  const worker = makeWorker(repoDir);
  for (let i = 0; i < 7; i += 1) {
    const id = `11234567800012594${String(i).padStart(2, "0")}`;
    const old = bugFromDict({ id, name: "历史 needs_info 任务", description: "描述" }, "111");
    worker.store.upsertJob(old, {
      agent_state: "needs_info",
      failure_reason: `只读 Agent 明确无法定位问题: 未找到相关模块（第 ${i} 个）`,
      finished_at: "2026-09-03 21:00:00",
    });
  }
  assert.equal(worker.recoverLegacyInvestigationNeedsInfo(), 5);
  assert.equal(worker.store.listJobs("needs_info").length, 2);
  assert.equal(worker.recoverLegacyInvestigationNeedsInfo(), 2);
  assert.equal(worker.store.listJobs("needs_info").length, 0);
  assert.equal(worker.recoverLegacyInvestigationNeedsInfo(), 0);
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

