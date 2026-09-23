/**
 * 编译后最小探针：coordinator（plan/summary）与 provider 模型注册。
 *
 * 为什么需要它：本沙箱禁止任何带管道 stdio 的子进程（vitest 的 tinypool / vite 都要 fork，
 * 真实 `pi` 也是 stdio: ["ignore","pipe","pipe"]），`npx vitest run` 直接以 spawn EPERM 退出。
 * 因此这里用 dist/ 的编译产物直接执行 tests/agentRoles.test.ts、tests/piConfig.test.ts 中
 * 新增用例的等价断言，作为可执行证据。
 *
 * 覆盖：
 *  1) coordinator 的严格 JSON 解析（成功 / 各类非法输出降级）与 prompt 契约（只读无工具、
 *     事实不可改写、非硬约束措辞）；
 *  2) Worker 编排的真实调用点：plan 在调查前、summary 在交付前，均为 role=coordinator +
 *     tools=[] + read-only；成功注入；失败降级且不影响任务结论；取消必须向上抛；
 *  3) ensurePiModels：缺 model_id 仍按 base_url/api_key 注册 provider；动态收集 agents.roles
 *     中属于该 provider 的全部模型；跨 provider 不误注册；model_id 仅可选回退；配置告警合理。
 *
 * 唯一被替换的边界仍是操作系统的子进程（见上）；其余全部走 dist/ 里的真实编译代码。
 *   node tests/coordinatorAndModels.probe.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

// ---- 子进程边界：只提供「能正常结束、无输出」的假子进程（本探针不依赖任何外部命令） ----
const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
childProcess.spawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => true;
  setTimeout(() => {
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
  buildCoordinatorPlanPrompt, buildCoordinatorSummaryPrompt,
  formatCoordinatorPlanForPrompt, formatCoordinatorSummaryForDelivery,
  parseCoordinatorPlan, parseCoordinatorSummary,
} = await import("../dist/coordinator.js");
const {
  AGENT_ROLES, piProviderModelIds, piProviderModelsProblem, roleModelIdsForProvider, parseAgentsConfig,
  agentRoleEffectiveModel, agentRoleModelSummary,
} = await import("../dist/agentRoles.js");
const { actualModelUses } = await import("../dist/attemptAudit.js");
const {
  PiAgent, ensurePiModels, effectivePiModel, AgentCancelledError, AgentTimeoutError,
  AgentInvestigationLimitError,
} = await import("../dist/agent.js");
const { Worker, _COORDINATOR_PLAN_TIMEOUT_S, _COORDINATOR_SUMMARY_TIMEOUT_S } = await import("../dist/worker.js");
const { StateStore } = await import("../dist/state.js");
const { bugFromDict } = await import("../dist/models.js");
const { DEFAULT_PRIORITY_WEIGHT, validateConfig, loadConfig } = await import("../dist/config.js");
const { P4Client } = await import("../dist/p4.js");

const cases = [];
const it = (name, fn) => cases.push({ name, fn });

const tmpdirs = [];
const tmpdir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
// 1) coordinator 解析与 prompt 契约
// ---------------------------------------------------------------------------
const PLAN_JSON = 'FINAL_RESULT: {"understanding":"登录崩溃","focus_areas":["Login.ts 的点击处理"],'
  + '"risks":["缺少防抖"],"verification_hints":["跑登录单测"]}';
const SUMMARY_JSON = 'FINAL_RESULT: {"summary":"已完成最小修复","key_points":["请核对防抖阈值"]}';

it("unit: coordinator 严格 JSON —— 合法输出解析成功，非法一律降级为 null", () => {
  assert.deepEqual(parseCoordinatorPlan(PLAN_JSON), {
    understanding: "登录崩溃",
    focus_areas: ["Login.ts 的点击处理"],
    risks: ["缺少防抖"],
    verification_hints: ["跑登录单测"],
  });
  assert.deepEqual(parseCoordinatorSummary(SUMMARY_JSON), {
    summary: "已完成最小修复", key_points: ["请核对防抖阈值"],
  });
  // 允许代码围栏，但必须是单个完整 JSON 对象
  assert.ok(parseCoordinatorPlan("```json\n" + PLAN_JSON + "\n```"));
  // 空 / 非 JSON / 半截 JSON / 数组 / 字段类型不符 / 空 summary 全部降级
  for (const bad of [
    "", "   ", "这不是 JSON", "FINAL_RESULT: {\"understanding\":\"x\"",
    "FINAL_RESULT: [1,2,3]", "FINAL_RESULT: {\"understanding\":123,\"focus_areas\":\"x\"}",
  ]) assert.equal(parseCoordinatorPlan(bad), null, `应降级: ${bad}`);
  assert.equal(parseCoordinatorSummary('FINAL_RESULT: {"summary":"  "}'), null);
});

it("unit: coordinator prompt 把「只读无工具、非硬约束、不得改写事实」写进合同", () => {
  const planPrompt = buildCoordinatorPlanPrompt({
    bug: { id: "1", title: "t" }, context: { description: "d" },
    repo: { name: "r", roots: [{ alias: "project", path: "C:/x" }] },
  });
  assert.match(planPrompt, /只读、无工具/);
  assert.match(planPrompt, /不得指定 planned_files/);
  assert.match(planPrompt, /FINAL_RESULT: \{"understanding"/);

  const summaryPrompt = buildCoordinatorSummaryPrompt({ bug: { id: "1", title: "t" }, facts: { a: 1 } });
  assert.match(summaryPrompt, /不得改写、不得覆盖、不得反驳这些事实/);
  assert.match(summaryPrompt, /不得把未通过的验证写成通过/);
  assert.match(summaryPrompt, /FINAL_RESULT: \{"summary"/);

  const planText = formatCoordinatorPlanForPrompt(parseCoordinatorPlan(PLAN_JSON));
  assert.match(planText, /仅供参考，不是硬约束/);
  assert.match(planText, /与真实代码冲突时一律以代码为准/);
  const deliveryText = formatCoordinatorSummaryForDelivery(parseCoordinatorSummary(SUMMARY_JSON));
  assert.match(deliveryText, /不覆盖上述测试\/文件\/评审事实/);
});

// ---------------------------------------------------------------------------
// 2) Worker 编排：真实调用点 + 成功/降级/取消
// ---------------------------------------------------------------------------
function makeBug() {
  return bugFromDict({
    id: "1123456780001234007", workspace_id: "111", title: "登录页偶现崩溃",
    description: "快速点击登录按钮时偶现崩溃。", status: "new", priority: "1",
    priority_label: "高", severity: "严重", module: "login", current_owner: "me",
    reporter: "tester", created: "2026-08-05 10:00:00",
  }, "111");
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

const EDITED_LOGIN = [{ depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" }];

function installP4() {
  P4Client.prototype.sync = async () => "";
  P4Client.prototype.edit = async () => "";
  P4Client.prototype.revertUnchanged = async () => "";
  P4Client.prototype.revert = async () => "";
  P4Client.prototype.reconcilePreview = async () => "";
  P4Client.prototype.reconcile = async () => "";
  P4Client.prototype.diffUnified = async () => "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed";
  P4Client.prototype.createPending = async () => 4321;
  let openedCalls = 0;
  P4Client.prototype.opened = async () => {
    openedCalls += 1;
    return openedCalls === 1 ? [] : EDITED_LOGIN;
  };
}

function makeWorker(repoDir, agentsRaw = ENABLED_COORDINATOR_ROLES) {
  const store = new StateStore(":memory:");
  const cfg = {
    max_bugs_per_run: 10, max_attempts: 1, agent_timeout_s: 1800,
    mcp_servers: {},
    quality: {
      admission: { min_score: 0, require_reproduction_signal: false, manual_keywords: [] },
      require_verification: false, max_changed_files: 8, max_diff_lines: 500,
    },
    review: { enabled: false, max_fix_rounds: 0 },
    // 与真实链路一致：经过角色层解析（coordinator 的 opt-in 判定读的就是解析结果）
    agents: { ...parseAgentsConfig(agentsRaw), problems: [] },
    exclude_status: ["resolved", "closed", "rejected"],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [{ workspace_id: "111", owner: "me", repos: [{ name: "r", path: repoDir, verify_cmds: [] }], default_repo: "r" }],
    pi: { provider: { id: "gateway", model_id: "fix-model" } },
    p4: {}, web: {}, tapd: {}, config_path: "",
  };
  const worker = new Worker(cfg, store);
  worker.clients["111"] = { addComment: async () => {}, updateBug: async () => {} };
  worker.verifyCandidate = async () => ({
    opened: EDITED_LOGIN, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
    summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
  });
  return worker;
}

const originalRun = PiAgent.prototype.run;
function restorePrototypes() {
  PiAgent.prototype.run = originalRun;
}

/** 启用 coordinator 的等价写法：`model: ''` 会解析成 `{ model: '' }`（空 = 沿用 pi.provider）。 */
const ENABLED_COORDINATOR_ROLES = { roles: { coordinator: { model: "" } } };
/** 旧 config.yaml 的默认形态：整段省略 roles → 不启用 coordinator，调用序列逐字不变。 */
const DISABLED_COORDINATOR_ROLES = { roles: {} };

async function runBug({ agents, results }) {
  restorePrototypes();
  const repoDir = tmpdir("tapd-probe-coordinator-");
  fs.writeFileSync(path.join(repoDir, "Login.ts"), "export const login = true;\n");
  installP4();
  const worker = makeWorker(repoDir, agents);
  const bug = makeBug();
  const calls = [];
  let coordinatorCalls = 0;
  PiAgent.prototype.run = async (opts) => {
    calls.push(opts);
    if (opts.role === "coordinator") {
      coordinatorCalls += 1;
      const outcome = results.coordinator?.[coordinatorCalls - 1];
      if (outcome === "timeout") throw new AgentTimeoutError("Agent 调用超时(120s): pi", "");
      if (outcome) return outcome;
      // 默认：第一次是调查前的计划，第二次是交付前的汇总。
      return makeResult({ raw_output: coordinatorCalls === 1 ? PLAN_JSON : SUMMARY_JSON });
    }
    const others = calls.filter((call) => call.role !== "coordinator").length;
    if (others === 1) return makeInvestigation("project:Login.ts");
    return makeResult({ changed_files: ["project:Login.ts"], summary: "实施完成：按 planned_files 做最小修复" });
  };
  try {
    await worker.processBug(bug);
  } finally {
    restorePrototypes();
  }
  return { worker, bug, calls };
}

it("chain: 未配置 coordinator 时不新增任何调用（调用序列与改造前逐字一致）", async () => {
  const { calls, worker, bug } = await runBug({ agents: DISABLED_COORDINATOR_ROLES, results: {} });
  assert.deepEqual(calls.map((call) => call.role), ["investigation", "implementation"]);
  const description = String(worker.store.getJob(bug.id).generated_description);
  assert.ok(!description.includes("协调者补充说明"));
  assert.ok(!String(calls.find((call) => call.role === "investigation").prompt).includes("调查计划建议"));
  const events = worker.store.audit.attempts(bug.id).at(-1).events;
  assert.equal(events.find((event) => event.kind === "coordinator_plan"), undefined);
  assert.equal(events.find((event) => event.kind === "coordinator_summary"), undefined);
});

it("chain: coordinator plan 在调查前、summary 在交付前，均只读无工具且不参与决策", async () => {
  const { worker, bug, calls } = await runBug({ agents: ENABLED_COORDINATOR_ROLES, results: {} });
  assert.deepEqual(calls.map((call) => call.role), [
    "coordinator", "investigation", "implementation", "coordinator",
  ]);
  for (const call of calls.filter((item) => item.role === "coordinator")) {
    assert.deepEqual(call.tools, [], "coordinator 必须无工具");
    assert.equal(call.sandboxMode, "read-only", "coordinator 必须只读");
    assert.deepEqual(call.mcpServers, [], "coordinator 不挂任何 MCP");
    assert.deepEqual(call.requiredMcpServers, []);
    assert.equal(call.repoDir && typeof call.repoDir, "string");
  }
  // 计划建议只进调查 prompt，且明确标注仅供参考
  const investigationPrompt = String(calls.find((call) => call.role === "investigation").prompt);
  assert.match(investigationPrompt, /调查计划建议（由 coordinator 角色只读生成，仅供参考，不是硬约束）/);
  assert.match(investigationPrompt, /Login\.ts 的点击处理/);
  // 汇总只作为附加段落进交付描述，事实文字保留
  const description = String(worker.store.getJob(bug.id).generated_description);
  assert.match(description, /实施完成：按 planned_files 做最小修复/);
  assert.match(description, /协调者补充说明/);
  assert.equal(worker.store.getJob(bug.id).agent_state, "verified");
  // 审计：两次调用都落库，role=coordinator，且不落 prompt 明文
  const events = worker.store.audit.attempts(bug.id).at(-1).events;
  const planEvent = events.find((event) => event.kind === "coordinator_plan");
  const summaryEvent = events.find((event) => event.kind === "coordinator_summary");
  assert.equal(planEvent.payload.role, "coordinator");
  assert.equal(summaryEvent.payload.role, "coordinator");
  assert.match(String(planEvent.payload.plan_hash), /^[0-9a-f]{64}$/, "计划审计只落哈希");
  assert.match(String(summaryEvent.payload.summary_hash), /^[0-9a-f]{64}$/, "汇总审计只落哈希");
  const inputEvents = events.filter((event) => event.kind === "agent" && event.payload.role === "coordinator");
  // 本探针替换了 PiAgent.prototype.run，因此不会产生真实审计事件（真实审计链路由
  // tests/agentRoles.test.ts 的用例覆盖）；这里只要求「建议正文不落 prompt 明文」。
  assert.equal(inputEvents.length, 0);
  const realAuditEvents = events.filter((event) => event.payload && event.payload.role !== undefined);
  assert.ok(realAuditEvents.length > 0);
  assert.ok(!JSON.stringify(realAuditEvents).includes("Login.ts 的点击处理"),
    "带 role 的审计事件不得落建议正文/prompt 明文");
});

it("chain: coordinator 失败降级，任务结论与交付事实完全不变", async () => {
  const degraded = await runBug({
    agents: ENABLED_COORDINATOR_ROLES,
    results: { coordinator: ["timeout", "timeout"] },
  });
  const investigationPrompt = String(degraded.calls.find((call) => call.role === "investigation").prompt);
  assert.ok(!investigationPrompt.includes("调查计划建议"), "降级后不得注入建议段");
  const description = String(degraded.worker.store.getJob(degraded.bug.id).generated_description);
  assert.match(description, /实施完成：按 planned_files 做最小修复/);
  assert.ok(!description.includes("协调者补充说明"), "降级后不得追加汇总段");
  assert.equal(degraded.worker.store.getJob(degraded.bug.id).agent_state, "verified");
  const events = degraded.worker.store.audit.attempts(degraded.bug.id).at(-1).events;
  assert.equal(events.find((event) => event.kind === "coordinator_plan").payload.degraded, true);
  assert.equal(events.find((event) => event.kind === "coordinator_summary").payload.degraded, true);
});

it("chain: summary 不覆盖测试/文件/评审事实（分类与文件清单仍由编排器按事实决定）", async () => {
  const { worker, bug, calls } = await runBug({
    agents: ENABLED_COORDINATOR_ROLES,
    results: {
      coordinator: [
        makeResult({ raw_output: PLAN_JSON }),
        // coordinator 自称「全通过 + 改了 9 个文件」：这些文字只能出现在被标注的附加段里
        makeResult({ raw_output: 'FINAL_RESULT: {"summary":"测试全部通过，共改动 9 个文件","key_points":[]}' }),
      ],
    },
  });
  const job = worker.store.getJob(bug.id);
  // 分类仍由编排器按事实决定（验证门通过 → verified），不因 coordinator 的文字改变
  assert.equal(job.agent_state, "verified");
  assert.match(String(job.files), /project:\/\/depot\/Login\.ts/);
  // 给 coordinator 的 facts 必须来自编排器记录的事实，而不是它的自述
  const summaryPrompt = String(calls.filter((call) => call.role === "coordinator").at(-1).prompt);
  assert.match(summaryPrompt, /"passed": true/, "验证结果必须作为事实喂给 coordinator");
  assert.match(summaryPrompt, /machine_verification/, "facts 必须包含机器验证结果");
  assert.match(summaryPrompt, /review/);
  // 交付描述里的权威事实段仍然来自真实改动，附加段被明确标注为「未参与决策」
  const description = String(job.generated_description);
  assert.match(description, /实施完成：按 planned_files 做最小修复/);
  const advisoryIndex = description.indexOf("协调者补充说明");
  assert.ok(advisoryIndex > 0, "附加段必须在事实文字之后");
  assert.ok(description.indexOf("实施完成：按 planned_files 做最小修复") < advisoryIndex);
  assert.match(description.slice(advisoryIndex), /不覆盖上述测试\/文件\/评审事实/);
});

it("chain: 人工取消从 coordinator 调用向上传播：中断整个流程，不降级也不继续跑调查", async () => {
  restorePrototypes();
  const repoDir = tmpdir("tapd-probe-coordinator-cancel-");
  fs.writeFileSync(path.join(repoDir, "Login.ts"), "export const login = true;\n");
  installP4();
  const worker = makeWorker(repoDir);
  const bug = makeBug();
  const calls = [];
  PiAgent.prototype.run = async (opts) => {
    calls.push(opts);
    if (opts.role === "coordinator") throw new AgentCancelledError("Agent 调用被人工取消: pi");
    return makeInvestigation("project:Login.ts");
  };
  try {
    // 取消不走异常出口（reason=中断），但必须整单终止：不得降级成「没有建议」继续调查。
    await worker.processBug(bug);
  } finally {
    restorePrototypes();
  }
  assert.deepEqual(calls.map((call) => call.role), ["coordinator"], "取消后不得继续跑调查");
  const events = worker.store.audit.attempts(bug.id).at(-1).events;
  assert.equal(events.find((event) => event.kind === "coordinator_plan"), undefined,
    "取消不是「降级」：不得落 degraded 事件");
  assert.ok(worker.store.listEvents(bug.id).some((event) => /人工中断/.test(String(event.msg))),
    "取消必须留下中断记录");
  assert.equal(worker.store.getJob(bug.id).agent_state, "pending", "取消后回到待处理队列");
});

// ---------------------------------------------------------------------------
// 3) provider 注册：缺 model_id 也能注册 + 动态收集角色模型 + 跨 provider 不误注册
// ---------------------------------------------------------------------------
const writeConfig = (dir, yaml) => {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml);
  return loadConfig(file, path.join(dir, ".env"), path.join(dir, "overrides.yaml"));
};

it("unit: ensurePiModels 缺 model_id 时仍注册 provider，模型动态取自 agents.roles", () => {
  const dir = tmpdir("tapd-probe-models-");
  const config = writeConfig(dir, `
pi:
  provider:
    base_url: https://gateway.example.com
    api_key: test-key
agents:
  roles:
    investigation: { model: inv-model }
    review: { model: review-model }
`);
  const modelFile = path.join(dir, "models.json");
  ensurePiModels(config.pi, modelFile, config);
  const gateway = JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway;
  assert.equal(gateway.baseUrl, "https://gateway.example.com");
  assert.equal(gateway.apiKey, "test-key");
  assert.deepEqual(gateway.models.map((model) => model.id).sort(), ["inv-model", "review-model"]);
  // model_id 只作为可选回退：没有它时 --model 为空（各角色用自己的角色模型）
  assert.equal(effectivePiModel(config.pi), "");
  assert.deepEqual(piProviderModelIds(config).sort(), ["inv-model", "review-model"]);
  assert.equal(piProviderModelsProblem(config), null);
});

it("unit: 只收集属于本 provider 的角色模型，model_id 是可选的首个回退项", () => {
  const dir = tmpdir("tapd-probe-models-scope-");
  const config = writeConfig(dir, `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
    model_id: fix-model
agents:
  roles:
    implementation: { model: impl-model }
    review: { model: "gateway/review-model" }
    recovery: { model: "other-provider/other-model" }
    coordinator: { model: " gateway/coord-model " }
`);
  const modelFile = path.join(dir, "models.json");
  ensurePiModels(config.pi, modelFile, config);
  const gateway = JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway;
  assert.deepEqual(gateway.models.map((model) => model.id),
    ["fix-model", "impl-model", "review-model", "coord-model"]);
  assert.ok(!JSON.stringify(gateway).includes("other-model"), "跨 provider 的模型不得误注册");
  // 纯函数口径一致
  assert.deepEqual(roleModelIdsForProvider("gateway",
    ["impl-model", "gateway/review-model", "other-provider/other-model"]),
  ["impl-model", "review-model"]);
  assert.deepEqual(piProviderModelIds(config),
    ["fix-model", "impl-model", "review-model", "coord-model"]);
  assert.ok(AGENT_ROLES.includes("coordinator"));
});

it("unit: 注册不出任何模型时只告警不阻断，补齐任一项即消失", () => {
  const dir = tmpdir("tapd-probe-models-warn-");
  const empty = writeConfig(dir, `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
agents:
  roles:
    review: { model: "" }
`);
  const modelFile = path.join(dir, "models.json");
  ensurePiModels(empty.pi, modelFile, empty);
  assert.deepEqual(JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway.models, [],
    "provider 仍然注册（base_url/api_key 生效），只是没有模型");
  const problem = piProviderModelsProblem(empty);
  assert.ok(problem && problem.includes("agents.roles.<role>.model"));
  assert.ok(validateConfig(empty).includes(problem), "告警必须进入 validateConfig 的启动提示");

  const roleOnly = writeConfig(dir, `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
agents:
  roles:
    review: { model: review-model }
`);
  assert.equal(piProviderModelsProblem(roleOnly), null);
  assert.deepEqual(piProviderModelIds(roleOnly), ["review-model"]);

  const idOnly = writeConfig(dir, `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
    model_id: fix-model
`);
  assert.equal(piProviderModelsProblem(idOnly), null);
  assert.deepEqual(piProviderModelIds(idOnly), ["fix-model"]);
});

// ---------------------------------------------------------------------------
// 4) 模型展示口径：真实配置解析、写错位置的诊断、角色可见性、实际调用模型（审计 agent_input）
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

it("unit: 真实 config.yaml 的 coordinator 在 agents.roles 下启用，并沿用 gateway/gemini-3.8-flash", () => {
  const dir = tmpdir("tapd-probe-real-config-");
  const cfg = loadConfig(
    path.join(REPO_ROOT, "config.yaml"), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
  );
  assert.deepEqual(cfg.agents.problems, [], "真实 config.yaml 不得再有角色层告警（coordinator 写错位置）");
  assert.deepEqual(cfg.agents.roles.coordinator, { model: "" });
  assert.equal(effectivePiModel(cfg.pi), "gateway/gemini-3.8-flash");
  assert.equal(agentRoleEffectiveModel(cfg, "coordinator", effectivePiModel(cfg.pi)),
    "gateway/gemini-3.8-flash");
  const entry = agentRoleModelSummary(cfg, effectivePiModel(cfg.pi))
    .find((item) => item.role === "coordinator");
  assert.deepEqual(
    { configured: entry.configured, model: entry.model, effective: entry.effective_model, fallback: entry.uses_default_model },
    { configured: true, model: "", effective: "gateway/gemini-3.8-flash", fallback: true },
  );
});

it("unit: agents.coordinator（少一层 roles）必须告警并提示改写成 agents.roles.coordinator", () => {
  const misplaced = parseAgentsConfig({ coordinator: { model: "" }, roles: {} });
  assert.deepEqual(misplaced.roles, {}, "写错位置的条目不得被解析成角色（避免静默失效又不报错）");
  assert.ok(misplaced.problems.join("\n").includes("agents.coordinator"));
  assert.ok(misplaced.problems.join("\n").includes("agents.roles.coordinator"));
  assert.deepEqual(parseAgentsConfig({ typo: 1 }).roles, {});

  const dir = tmpdir("tapd-probe-misplaced-");
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, 'agents:\n  coordinator: { model: "" }\n');
  const cfg = loadConfig(file, path.join(dir, ".env"), path.join(dir, "overrides.yaml"));
  assert.equal(cfg.agents.roles.coordinator, undefined);
  assert.ok(validateConfig(cfg).join("\n").includes("agents.roles.coordinator"),
    "启动配置告警必须包含正确写法，避免再次静默失效");
});

it("chain: recovery 收尾与 coordinator 调用期间显示各自角色，跑完还原为阶段角色", async () => {
  restorePrototypes();
  const repoDir = tmpdir("tapd-probe-roles-visible-");
  fs.writeFileSync(path.join(repoDir, "Login.ts"), "export const login = true;\n");
  installP4();
  const worker = makeWorker(repoDir, {
    roles: { investigation: { model: "inv-model" }, coordinator: { model: "coord-model" } },
  });
  const bug = makeBug();
  const seen = [];
  PiAgent.prototype.run = async (opts) => {
    const stage = worker.status().current_stage;
    seen.push({ role: opts.role, stage: stage.current_stage, shown: stage.current_role, model: stage.current_model });
    if (opts.role === "coordinator") return makeResult({ raw_output: PLAN_JSON });
    const others = seen.filter((item) => item.role !== "coordinator").length;
    if (others === 1) throw new AgentInvestigationLimitError("调查达到工具预算", "工具 read: Login.ts");
    if (others === 2) return makeInvestigation("project:Login.ts");
    return makeResult({ changed_files: ["project/Login.ts"], summary: "实施完成" });
  };
  try {
    await worker.processBug(bug);
  } finally {
    restorePrototypes();
  }

  assert.deepEqual(seen.map((item) => [item.role, item.shown, item.model]), [
    // coordinator 的两次只读调用：角色/模型切到 coordinator（阶段标签仍是所属阶段）
    ["coordinator", "coordinator", "gateway/coord-model"],
    ["investigation", "investigation", "gateway/inv-model"],
    // recovery 收尾：模型未配置 → 沿用默认回退；角色必须显示 recovery（这正是本次修复的可见性）
    ["recovery", "recovery", "gateway/fix-model"],
    // 收尾结束后进入实施：角色/模型还原，不残留 recovery
    ["implementation", "implementation", "gateway/fix-model"],
    ["coordinator", "coordinator", "gateway/coord-model"],
  ]);
  assert.equal(seen[0].stage, "admission", "coordinator 计划调用落在准入之后、调查之前");
  const idle = worker.status().current_stage;
  assert.deepEqual(
    { stage: idle.current_stage, role: idle.current_role, model: idle.current_model },
    { stage: null, role: null, model: "" },
  );
});

it("unit: actual_models 只认审计 agent_input（多角色多模型 + 调用次数），不拿默认回退模型充数", async () => {
  const worker = makeWorker(tmpdir("tapd-probe-actual-models-"), DISABLED_COORDINATOR_ROLES);
  const bug = makeBug();
  worker.store.upsertJob(bug, { agent_state: "candidate", agent: "pi", model: "gateway/fix-model" });
  // 详情页 = Tapd 实时字段 + 本地状态：固定「我的 bug 列表」让详情能取到 bug 行
  worker.fetchMyBugs = async () => [bug];
  const attemptId = worker.store.audit.begin({
    bug_id: bug.id, workspace_id: "111", input: {}, metadata: { default_model: "gateway/fix-model" },
  });
  worker.store.audit.event(attemptId, "agent", {
    phase: "investigation", kind: "agent_input", role: "investigation", model: "gateway/inv-model",
  });
  worker.store.audit.event(attemptId, "agent", {
    phase: "implementation", kind: "agent_input", role: "recovery", model: "gateway/fix-model",
  });
  worker.store.audit.event(attemptId, "agent", {
    phase: "implementation", kind: "agent_input", role: "recovery", model: "gateway/fix-model",
  });
  // 非 agent_input（agent_usage 等）不参与「实际调用过什么」的口径
  worker.store.audit.event(attemptId, "agent", {
    phase: "review", kind: "agent_usage", role: "review", model: "gateway/not-a-call",
  });
  worker.store.audit.event(attemptId, "finished", { state: "candidate" });

  const detail = await worker.bugDetailForWeb(bug.id);
  assert.deepEqual(detail.actual_models, [
    { role: "investigation", model: "gateway/inv-model", calls: 1 },
    { role: "recovery", model: "gateway/fix-model", calls: 2 },
  ]);
  // 默认回退模型单独给出，不冒充实际调用
  assert.equal(detail.default_model, "gateway/fix-model");
  assert.deepEqual(actualModelUses([]), []);
  assert.deepEqual(actualModelUses([{ events: [] }]), []);
  assert.deepEqual(actualModelUses([{
    events: [{ kind: "agent", payload: { kind: "agent_input", model: "gateway/x" } }],
  }]), [{ role: null, model: "gateway/x", calls: 1 }], "未标注角色的历史调用必须保持 role=null");
});

it("chain: GET /api/settings 展示「默认回退模型」+ 角色模型摘要，且不泄露密钥", async () => {
  const { createApp } = await import("../dist/web/app.js");
  const repoDir = tmpdir("tapd-probe-settings-");
  const worker = makeWorker(repoDir, { roles: { coordinator: { model: "coord-model" } } });
  const app = createApp(worker.config, worker.store, worker);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // 字段名 effective_model 保留（兼容），但语义是「默认回退模型」，并额外给出 default_model
    assert.equal(body.pi.default_model, "gateway/fix-model");
    assert.equal(body.pi.effective_model, "gateway/fix-model");
    const byRole = (role) => body.pi.agent_roles.find((item) => item.role === role);
    assert.equal(body.pi.agent_roles.length, AGENT_ROLES.length, "所有角色都要列出（含未配置的）");
    assert.deepEqual(
      { configured: byRole("coordinator").configured, effective: byRole("coordinator").effective_model, fallback: byRole("coordinator").uses_default_model },
      { configured: true, effective: "gateway/coord-model", fallback: false },
    );
    assert.deepEqual(
      { configured: byRole("recovery").configured, effective: byRole("recovery").effective_model, fallback: byRole("recovery").uses_default_model },
      { configured: false, effective: "gateway/fix-model", fallback: true },
    );
    // 不泄露密钥：只回传「是否已设置」，绝不回传 api_key 明文（api_key_env 只是变量名）
    assert.ok(!("api_key" in body.pi.provider), "设置接口不得回传 api_key 明文");
    assert.equal(typeof body.pi.provider.has_api_key, "boolean");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${error?.stack ?? error}`);
    if (error?.actual !== undefined) console.error("       actual:", inspect(error.actual, { depth: 4 }));
    if (error?.expected !== undefined) console.error("       expected:", inspect(error.expected, { depth: 4 }));
  }
}
for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\ncoordinator/models 探针: ${cases.length - failed}/${cases.length} 通过`
  + `（coordinator plan 派生上限 ${_COORDINATOR_PLAN_TIMEOUT_S}s / summary 派生上限 ${_COORDINATOR_SUMMARY_TIMEOUT_S}s）`);
process.exit(failed ? 1 : 0);
