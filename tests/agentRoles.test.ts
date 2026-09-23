/** 显式角色层测试：配置向后兼容、角色 model/timeout 覆盖实际生效、审计可观察。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_ROLES,
  ORCHESTRATION_MAX_DEPTH,
  SUB_AGENT_ORCHESTRATION_DEPTH,
  agentRoleEffectiveModel,
  agentRoleModel,
  agentRoleModelSummary,
  agentRoleSnapshot,
  agentRoleTimeoutS,
  parseAgentsConfig,
} from "../src/agentRoles.js";
import { actualModelUses } from "../src/attemptAudit.js";
import { DEFAULT_PRIORITY_WEIGHT, loadConfig, validateConfig } from "../src/config.js";
import type { Config, RepoConfig } from "../src/config.js";
import {
  AgentCancelledError, AgentInvestigationLimitError, AgentTimeoutError, PiAgent, effectivePiModel,
} from "../src/agent.js";
import { P4Client } from "../src/p4.js";
import { StateStore } from "../src/state.js";
import { Worker } from "../src/worker.js";
import { bugFromDict } from "../src/models.js";
import type { AgentResult, Bug } from "../src/models.js";

const dirs: string[] = [];
function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-agent-roles-"));
  dirs.push(dir);
  return dir;
}

/** 仓库根（本文件在 tests/ 下）：用于直接加载真实 config.yaml / config.example.yaml。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 加载仓库里的真实配置文件，但用临时目录里的 .env / overrides.yaml，避免被本机覆盖项干扰。 */
function loadRepoConfig(fileName: string): Config {
  const dir = tmpdir();
  return loadConfig(
    path.join(REPO_ROOT, fileName), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
  );
}

/** 受限沙箱（DSH workspace-write）不允许带管道 stdio 的子进程，fake pi 无法启动。
 *  此时角色解析仍在 spawn 之前完成，可用审计/进度断言；argv 断言在有 spawn 权限的环境执行。 */
function pipeSpawnAvailable(): boolean {
  try {
    const probe = spawnSync(process.execPath, ["-e", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    return !probe.error;
  } catch {
    return false;
  }
}
const PIPE_SPAWN_ALLOWED = pipeSpawnAvailable();

/** 允许 spawn 抛错（本沙箱会以 AgentRuntimeError 抛出 EPERM）；只关心调用前已确定的角色解析结果。 */
async function runToleratingSpawnFailure(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // 沙箱拒绝 spawn：角色解析/审计发生在 spawn 之前，断言仍然有效
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fake pi（与 core.test.ts 相同的 shim 机制；不调真实 pi / 模型）
// ---------------------------------------------------------------------------
function writeFakePi(dir: string, body: string): void {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "pi.cmd"), "@echo off\r\n" + body + "\r\n");
  } else {
    fs.writeFileSync(path.join(dir, "pi"), "#!/bin/sh\n" + body + "\n");
    fs.chmodSync(path.join(dir, "pi"), 0o755);
  }
}

function withFakePiOnPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const orig = process.env.PATH;
  process.env.PATH = dir + path.delimiter + (orig ?? "");
  return fn().finally(() => {
    process.env.PATH = orig;
  });
}

/** 记录 argv 的 fake pi：用来证明角色模型真的拼进了 `--model`。 */
function writeArgsRecordingPi(dir: string): void {
  const script = path.join(dir, "args.cjs");
  fs.writeFileSync(script, "require('fs').writeFileSync('args.txt',JSON.stringify(process.argv.slice(2))); console.log('done');");
  writeFakePi(dir, process.platform === "win32" ? `node "${script}" %*` : `node "${script}" "$@"`);
}

// ---------------------------------------------------------------------------
// 本地 Config / Worker 夹具
// ---------------------------------------------------------------------------
function makeConfig(over: Partial<Config> = {}): Config {
  return {
    max_bugs_per_run: 10,
    max_attempts: 1,
    agent_timeout_s: 1800,
    mcp_servers: {},
    quality: {
      admission: { min_score: 0, require_reproduction_signal: false, manual_keywords: [] },
      require_verification: false,
      max_changed_files: 8,
      max_diff_lines: 500,
    },
    review: { enabled: false, max_fix_rounds: 0 },
    agents: { roles: {}, problems: [] },
    exclude_status: ["resolved", "closed", "rejected"],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [],
    pi: { provider: { id: "gateway", model_id: "fix-model" } },
    p4: {},
    web: {},
    tapd: {},
    config_path: "",
    ...over,
  };
}

function makeBug(over: Record<string, unknown> = {}): Bug {
  const data: Record<string, unknown> = {
    id: "1123456780001234007",
    workspace_id: "111",
    title: "登录页偶现崩溃",
    description: "快速点击登录按钮时偶现崩溃。",
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

function makeResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    ok: true, summary: "", changed_files: [], manual_assets: [], blocked_reasons: [],
    exit_code: 0, log: "", raw_output: "", ...over,
  };
}

function makeInvestigation(file: string): AgentResult {
  return makeResult({
    raw_output: `FINAL_RESULT: {"repair_contract":{"acceptance_cases":[{"given":"已进入目标功能","when":"触发工单操作","then":"返回预期结果且不再出现目标异常","source_refs":["evidence:0"]}],"preserved_behaviors":["正常输入继续完成原业务操作"],"domain_facts":[{"concept":"操作状态","meaning":"本次操作的业务结果","source_refs":["evidence:0"]}],"reuse_options":[{"symbol":"目标操作入口","action":"reuse","reason":"沿用原入口及错误处理路径"}],"open_questions":[]},"root_cause":"测试根因","evidence":["[观察] ${file}:1","[推断] 根因由该观察事实支持"],"reproduction":{"command":"","before":"复现失败"},"planned_files":["${file}"],"confidence":0.9,"blocked_reasons":[]}`,
  });
}

function makeWorker(repoPath: string, over: Partial<Config> = {}, verifyCmds: RepoConfig["verify_cmds"] = []): Worker {
  const store = new StateStore(":memory:");
  const cfg = makeConfig(over);
  cfg.workspaces = [{
    workspace_id: "111", owner: "me",
    repos: [{ name: "r", path: repoPath, verify_cmds: verifyCmds }],
    default_repo: "r",
  }];
  const worker = new Worker(cfg, store);
  // 假 tapd 客户端：backend=rest 时 key = workspace_id
  (worker as unknown as { clients: Record<string, unknown> }).clients["111"] = {
    addComment: async () => {}, updateBug: async () => {},
  };
  return worker;
}

function stubP4(recipe: {
  opened?: Array<unknown>;
  openedSequence?: Array<Array<unknown>>;
  changed?: () => boolean;
} = {}): void {
  vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
  vi.spyOn(P4Client.prototype, "edit").mockResolvedValue("");
  vi.spyOn(P4Client.prototype, "revertUnchanged").mockResolvedValue("");
  const changed = recipe.changed ?? (() => true);
  if (recipe.openedSequence) {
    let index = 0;
    vi.spyOn(P4Client.prototype, "opened").mockImplementation(async () =>
      (recipe.openedSequence![Math.min(index++, recipe.openedSequence!.length - 1)] ?? []) as never);
  } else {
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue((recipe.opened ?? []) as never);
  }
  vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
  vi.spyOn(P4Client.prototype, "diffUnified").mockImplementation(async () => changed()
    ? "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed"
    : "");
  vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);
}

const editedLogin = [{ depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" }];

/** 详情页 = Tapd 实时字段 + 本地处理状态：固定「我的 bug 列表」让详情能取到 bug 行
 *  （否则 fetchBugForManual 取不到单，详情只剩本地 job 列）。 */
function stubMyBugs(w: Worker, bugs: Bug[]): void {
  (w as unknown as { fetchMyBugs: () => Promise<Bug[]> }).fetchMyBugs = async () => bugs;
}

/** coordinator（只读无工具）是编排器新增的两个调用点，几乎所有 processBug 用例都会经过它。
 *  这批用例的目标是**其它角色**的解析与派发，所以统一把 coordinator 调用降级成
 *  「本次没有建议」（空输出），既不产生额外噪音，也不影响被断言的阶段行为。
 *  coordinator 自身的成功/失败/取消路径由本文件末尾的专门用例覆盖。 */
function spyAgentRun(
  impl: (opts: { role?: string } & Record<string, unknown>) => Promise<AgentResult>,
): void {
  vi.spyOn(PiAgent.prototype, "run").mockImplementation((async (opts: { role?: string }) => {
    if (opts.role === "coordinator") return makeResult({ raw_output: "" });
    return impl(opts as { role?: string } & Record<string, unknown>);
  }) as never);
}

// ---------------------------------------------------------------------------
// 配置：向后兼容 + 角色覆盖
// ---------------------------------------------------------------------------
describe("agents 角色配置", () => {
  it("旧 config.yaml 不含 agents：角色覆盖为空，阶段预算与模型保持原值", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "config.yaml"), "agent_timeout_s: 1800\n");
    const cfg = loadConfig(
      path.join(dir, "config.yaml"), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
    );
    expect(cfg.agents).toEqual({ roles: {}, problems: [] });
    expect(agentRoleModel(cfg, "review")).toBe("");
    expect(agentRoleTimeoutS(cfg, "implementation", cfg.agent_timeout_s)).toBe(1800);
    expect(agentRoleSnapshot(cfg)).toEqual({});
    expect(validateConfig(cfg).some((problem) => problem.includes("agents"))).toBe(false);
  });

  it("解析 agents.roles（别名归一 + provider 前缀）；非法角色/取值只告警不生效", () => {
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    base_url: "https://gateway.example.com"
    model_id: fix-model
agents:
  roles:
    reviewer: { model: review-role, timeout_s: 300 }
    implementation: { model: "other-provider/impl-2", timeout_s: 1200 }
    investigator: { timeout_s: 0 }
    unknown_role: { model: x }
    recovery: not-a-map
`);
    const cfg = loadConfig(
      path.join(dir, "config.yaml"), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
    );
    // 别名 reviewer/investigator 归一到规范角色名
    expect(Object.keys(cfg.agents!.roles).sort()).toEqual(["implementation", "review"]);
    expect(agentRoleModel(cfg, "review")).toBe("gateway/review-role");
    expect(agentRoleModel(cfg, "implementation")).toBe("other-provider/impl-2");
    expect(agentRoleTimeoutS(cfg, "review", cfg.agent_timeout_s)).toBe(300);
    expect(agentRoleTimeoutS(cfg, "implementation", cfg.agent_timeout_s)).toBe(1200);
    // 非法值不生效：investigator 的 timeout_s: 0 被忽略，退回回退值
    expect(agentRoleTimeoutS(cfg, "investigation", 1800)).toBe(1800);
    expect(agentRoleModel(cfg, "investigation")).toBe("");
    // 问题进启动告警，但不影响角色覆盖
    const problems = cfg.agents!.problems.join("\n");
    expect(problems).toContain("unknown_role");
    expect(problems).toContain("timeout_s 必须是正数");
    expect(problems).toContain("recovery 必须是映射");
    const warnings = validateConfig(cfg).join("\n");
    expect(warnings).toContain("unknown_role");
  });

  it("parseAgentsConfig 对缺省/错误类型一律回落为空覆盖", () => {
    expect(parseAgentsConfig(undefined)).toEqual({ roles: {}, problems: [] });
    expect(parseAgentsConfig({ roles: 3 }).problems[0]).toContain("agents.roles");
    // 显式写 model（含留空）算一次有效配置：`model: ""` = 启用该角色但沿用 pi.provider 默认模型
    expect(parseAgentsConfig({ roles: { review: { model: "  " } } }).roles).toEqual({ review: { model: "" } });
    expect(parseAgentsConfig({ roles: { coordinator: { model: "" } } }).roles).toEqual({ coordinator: { model: "" } });
    // 没有任何有效字段的条目不留空对象覆盖，避免"看起来配置了角色"其实没有任何行为差异
    // （示例配置里的注释形态 `coordinator:  # model: ...` 正是这种情况，必须保持不启用）
    expect(parseAgentsConfig({ roles: { coordinator: {} } }).roles).toEqual({});
    expect(parseAgentsConfig({ roles: { investigator: { timeout_s: 0 } } }).roles).toEqual({});
    expect(parseAgentsConfig({ roles: { REVIEW: { timeout_s: "45" } } }).roles.review)
      .toEqual({ timeout_s: 45 });
  });

  it("agents 下写错位置（agents.coordinator）必须告警并提示改成 agents.roles.coordinator", () => {
    // 真实部署里踩过的坑：coordinator 被写在 agents 这一层，解析器只认 agents.roles，
    // 于是「配置了但静默不生效」。这条用例锁死诊断口径。
    const misplaced = parseAgentsConfig({ coordinator: { model: "" }, roles: {} });
    expect(misplaced.roles).toEqual({});
    expect(misplaced.problems.join("\n")).toContain("agents.coordinator");
    expect(misplaced.problems.join("\n")).toContain("agents.roles.coordinator");
    // 同一形态经过完整 config 链路（loadConfig → validateConfig）也必须看得见
    const dir = tmpdir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
agents:
  coordinator: { model: "" }
  roles:
    review: { model: review-role }
`);
    const cfg = loadConfig(
      path.join(dir, "config.yaml"), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
    );
    expect(cfg.agents!.roles.coordinator).toBeUndefined(); // 仍不被解析成角色（不产生行为差异）
    expect(validateConfig(cfg).join("\n")).toContain("agents.roles.coordinator");
    // 其它未知键同样只告警不生效
    expect(parseAgentsConfig({ typo: 1 }).problems.join("\n")).toContain("agents.typo");
    // 正确写法不产生任何问题
    expect(parseAgentsConfig({ roles: { coordinator: { model: "" } } }).problems).toEqual([]);
  });

  it("真实 config.yaml：coordinator 在 agents.roles 下启用，模型沿用 gateway/gemini-3.8-flash", () => {
    const cfg = loadRepoConfig("config.yaml");
    // 位置正确：不再是 agents.coordinator，因此没有任何角色层告警
    expect(cfg.agents!.problems).toEqual([]);
    expect(cfg.agents!.roles.coordinator).toEqual({ model: "" });
    // 启用判定读的就是「角色条目是否存在且解析出有效字段」
    expect(Boolean(cfg.agents!.roles.coordinator)).toBe(true);
    // model 留空 = 沿用 pi.provider 默认模型；该默认模型必须真的来自配置而不是被写死
    expect(agentRoleModel(cfg, "coordinator")).toBe("");
    expect(effectivePiModel(cfg.pi)).toBe("gateway/gemini-3.8-flash");
    expect(agentRoleEffectiveModel(cfg, "coordinator", effectivePiModel(cfg.pi)))
      .toBe("gateway/gemini-3.8-flash");
    // 摘要口径：coordinator 标为「已配置，但走默认回退模型」
    expect(agentRoleModelSummary(cfg, effectivePiModel(cfg.pi)).find((e) => e.role === "coordinator"))
      .toMatchObject({
        configured: true, model: "",
        effective_model: "gateway/gemini-3.8-flash", uses_default_model: true,
      });
  });

  it("config.example.yaml：coordinator 与其它角色同级（示例不得再写成 agents.coordinator）", () => {
    const cfg = loadRepoConfig("config.example.yaml");
    expect(cfg.agents!.problems).toEqual([]);
    expect(cfg.agents!.roles.coordinator).toEqual({ model: "" });
    // 示例里的 provider 是占位模型；coordinator 留空即沿用该默认回退值
    expect(agentRoleEffectiveModel(cfg, "coordinator", effectivePiModel(cfg.pi)))
      .toBe(effectivePiModel(cfg.pi));
  });

  it("agentRoleSnapshot 区分「显式启用但沿用默认模型」与「未配置」", () => {
    const cfg = makeConfig({
      agents: parseAgentsConfig({ roles: { coordinator: { model: "" }, review: { model: "review-role" } } }),
    });
    expect(agentRoleSnapshot(cfg)).toEqual({
      coordinator: { model: "" },
      review: { model: "gateway/review-role" },
    });
    // 未配置的角色不出现在快照里（旧配置行为不变）
    expect(agentRoleSnapshot(makeConfig({ agents: parseAgentsConfig({ roles: {} }) }))).toEqual({});
  });

  it("两层编排拓扑：子 Agent 深度为 1，最大深度 2（不提供递归派发入口）", () => {
    // coordinator 与其它角色同级：它同样是「第 2 层的一次性 Pi 调用」，不是第 3 层。
    expect(AGENT_ROLES).toEqual([
      "investigation", "implementation", "review", "recovery", "coordinator",
    ]);
    expect(SUB_AGENT_ORCHESTRATION_DEPTH).toBe(1);
    expect(ORCHESTRATION_MAX_DEPTH).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PiAgent：角色 -> 模型/时限/审计/进度
// ---------------------------------------------------------------------------
describe("PiAgent 角色解析与审计", () => {
  it("角色解析在 spawn 之前完成：审计与进度带 role/模型/时限，且不落 prompt 明文", async () => {
    const d = tmpdir();
    writeArgsRecordingPi(d);
    const cfg = makeConfig({
      agents: { roles: { review: { model: "review-role", timeout_s: 240 } }, problems: [] },
    });
    const events: Array<Record<string, unknown>> = [];
    const progress: string[] = [];
    await runToleratingSpawnFailure(() => new PiAgent(cfg).run({
      prompt: "SECRET_PROMPT_MARKER_7d1",
      repoDir: d,
      role: "review",
      tools: ["read"],
      sandboxMode: "read-only",
      onAudit: (event) => events.push(event),
      onProgress: (msg) => progress.push(msg),
    }));

    const input = events.find((event) => event.kind === "agent_input");
    expect(input).toBeDefined();
    expect(input).toMatchObject({
      role: "review", model: "gateway/review-role", timeout_s: 240,
      orchestration_depth: SUB_AGENT_ORCHESTRATION_DEPTH, sandbox: "read-only",
      tools: ["read"],
    });
    expect(String(input!.prompt_hash)).toMatch(/^[0-9a-f]{64}$/);
    // 审计与进度都不得出现 prompt 明文
    expect(JSON.stringify(events)).not.toContain("SECRET_PROMPT_MARKER_7d1");
    expect(progress.join("\n")).not.toContain("SECRET_PROMPT_MARKER_7d1");
    // 角色单独一行，原有进度行格式逐字不变
    expect(progress.some((line) => line.endsWith("Pi: 角色 role=review（独立只读评审：核对 diff、验收证据与复用情况）"))).toBe(true);
    expect(progress.some((line) =>
      line.endsWith("Pi: 准备调用模型 gateway/review-role（sandbox=read-only，timeout=240s）"))).toBe(true);
  });

  it.skipIf(!PIPE_SPAWN_ALLOWED)("角色模型真正拼进 pi --model，并记录 agent_usage 角色", async () => {
    const d = tmpdir();
    writeArgsRecordingPi(d);
    const cfg = makeConfig({
      agents: { roles: { review: { model: "review-role", timeout_s: 240 } }, problems: [] },
    });
    const events: Array<Record<string, unknown>> = [];
    await withFakePiOnPath(d, async () => {
      await new PiAgent(cfg).run({
        prompt: "x", repoDir: d, role: "review",
        onAudit: (event) => events.push(event),
      });
    });
    const args: string[] = JSON.parse(fs.readFileSync(path.join(d, "args.txt"), "utf8"));
    expect(args[args.indexOf("--model") + 1]).toBe("gateway/review-role");
    expect(events.find((event) => event.kind === "agent_usage")!.role).toBe("review");
  });

  it("显式 model/timeout 优先于角色配置；未指定角色时沿用 agent_timeout_s 与 provider 默认模型", async () => {
    const d = tmpdir();
    const cfg = makeConfig({
      agents: { roles: { review: { model: "review-role", timeout_s: 240 } }, problems: [] },
    });
    const explicit: Array<Record<string, unknown>> = [];
    const plain: Array<Record<string, unknown>> = [];
    await runToleratingSpawnFailure(() => new PiAgent(cfg).run({
      prompt: "x", repoDir: d, role: "review", model: "explicit/model", timeoutS: 42,
      onAudit: (event) => explicit.push(event),
    }));
    await runToleratingSpawnFailure(() => new PiAgent(cfg).run({
      prompt: "x", repoDir: d, onAudit: (event) => plain.push(event),
    }));
    expect(explicit.find((event) => event.kind === "agent_input"))
      .toMatchObject({ role: "review", model: "explicit/model", timeout_s: 42 });
    // 无角色：模型回落到 pi.provider，时限回落到 agent_timeout_s（与改造前一致）
    expect(plain.find((event) => event.kind === "agent_input"))
      .toMatchObject({ role: null, model: "gateway/fix-model", timeout_s: 1800 });
  });

  it("role 的兼容别名 agentRole 同样生效", async () => {
    const d = tmpdir();
    const cfg = makeConfig({ agents: { roles: { implementation: { timeout_s: 600 } }, problems: [] } });
    const events: Array<Record<string, unknown>> = [];
    await runToleratingSpawnFailure(() => new PiAgent(cfg).run({
      prompt: "x", repoDir: d, agentRole: "implementation",
      onAudit: (event) => events.push(event),
    }));
    expect(events.find((event) => event.kind === "agent_input"))
      .toMatchObject({ role: "implementation", model: "gateway/fix-model", timeout_s: 600 });
  });
});

// ---------------------------------------------------------------------------
// Worker：调用点显式标注角色 + 角色时限真实生效
// ---------------------------------------------------------------------------
describe("worker 调用点角色标注", () => {
  it("调查→收尾→实施按角色派发，角色时限覆盖真实生效（默认值不变）", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");

    for (const configured of [false, true]) {
      const agents = configured
        ? { roles: { investigation: { timeout_s: 400 }, recovery: { timeout_s: 120 }, implementation: { timeout_s: 500 } }, problems: [] }
        : { roles: {}, problems: [] };
      const w = makeWorker(repo, { agents, agent_timeout_s: 1800 });
      const bug = makeBug();
      const calls: Array<Record<string, unknown>> = [];
      spyAgentRun(async (opts) => {
        if (opts.role !== "coordinator") calls.push(opts as unknown as Record<string, unknown>);
        if (calls.length === 1) {
          throw new AgentTimeoutError("Agent 调用超时(1800s): pi", "工具 read: Login.ts");
        }
        if (calls.length === 2) return makeInvestigation("project:Login.ts");
        return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
      });
      stubP4({ openedSequence: [[], editedLogin] });

      await w.processBug(bug);

      expect(calls.map((call) => call.role)).toEqual(["investigation", "recovery", "implementation"]);
      expect(calls.map((call) => call.timeoutS)).toEqual(
        configured ? [400, 120, 500] : [1800, 600, 1800],
      );
      // 调查阶段审计带角色与模型
      const investigationInput = w.store.audit.attempts(bug.id).at(-1)!.events
        .find((event: { kind: string }) => event.kind === "investigation_input");
      expect(investigationInput!.payload).toMatchObject({
        role: "investigation", model: "gateway/fix-model",
      });
      vi.restoreAllMocks();
    }
  });

  it("评审按 review 角色派发：角色模型是唯一入口，审计带 role=review", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(
      repo,
      {
        agents: { roles: { review: { model: "review-role", timeout_s: 300 } }, problems: [] },
        review: { enabled: true, max_fix_rounds: 0 },
      },
    );
    // 验证流水线本身不是本用例的目标（它会 spawn 外部验证命令）；这里只喂入已通过的验证结果，
    // 聚焦「评审阶段的角色模型/时限与审计标记」。验证门行为由 core.test.ts 覆盖。
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    const bug = makeBug();
    const calls: Array<Record<string, unknown>> = [];
    spyAgentRun(async (opts) => {
      if (opts.role !== "coordinator") calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) return makeInvestigation("project:Login.ts");
      if (calls.length === 2) return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
      return makeResult({
        raw_output: JSON.stringify({
          approved: true, requirement_match: "pass", behavioral_evidence: "static_only",
          reuse_and_lifecycle: "pass", unverified_items: [], note: "已检查", findings: [],
        }),
      });
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    expect(calls.map((call) => call.role)).toEqual(["investigation", "implementation", "review"]);
    expect(calls[2].model).toBe("gateway/review-role");
    expect(calls[2].timeoutS).toBe(300);
    const events = w.store.audit.attempts(bug.id).at(-1)!.events as Array<{ kind: string; payload: Record<string, unknown> }>;
    expect(events.find((event) => event.kind === "review_input")!.payload)
      .toMatchObject({ role: "review", model: "gateway/review-role" });
    expect(w.store.getJob(bug.id)?.agent_state).toBe("review_pending");
  });

  it("Reviewer 没有角色模型时只用 pi.provider 默认模型：调用、审计与尝试元数据三者一致", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    // review 段只保留 enabled/max_fix_rounds：旧的 review.model 已不是 Config 的一部分。
    const w = makeWorker(repo, {
      agents: { roles: { review: { timeout_s: 300 } }, problems: [] },
      review: { enabled: true, max_fix_rounds: 0 },
    });
    expect(Object.keys(w.config.review).sort()).toEqual(["enabled", "max_fix_rounds"]);
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    const bug = makeBug();
    const calls: Array<Record<string, unknown>> = [];
    spyAgentRun(async (opts) => {
      if (opts.role !== "coordinator") calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) return makeInvestigation("project:Login.ts");
      if (calls.length === 2) return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
      return makeResult({
        raw_output: JSON.stringify({
          approved: true, requirement_match: "pass", behavioral_evidence: "static_only",
          reuse_and_lifecycle: "pass", unverified_items: [], note: "已检查", findings: [],
        }),
      });
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    // 无角色模型 → pi.provider 默认（gateway/fix-model）；Reviewer 不接受任何其它入口。
    expect(calls[2].model).toBe("gateway/fix-model");
    const attempt = w.store.audit.attempts(bug.id).at(-1)!;
    expect(attempt.events.find((event: { kind: string }) => event.kind === "review_input")!
      .payload).toMatchObject({ role: "review", model: "gateway/fix-model" });
    // 尝试元数据里的 review_model 与真实调用模型一致
    expect(attempt.metadata.review_model).toBe("gateway/fix-model");
  });
});

// ---------------------------------------------------------------------------
// coordinator 角色：plan 调用（调查前）/ summary 调用（交付前）
// ---------------------------------------------------------------------------
describe("coordinator 角色调用点", () => {
  const planJson = (over: Record<string, unknown> = {}): string => `FINAL_RESULT: ${JSON.stringify({
    understanding: "登录页快速点击崩溃",
    focus_areas: ["Login.ts 的点击处理"],
    risks: ["缺少防抖导致重复提交"],
    verification_hints: ["跑登录相关单测"],
    ...over,
  })}`;
  const summaryJson = (over: Record<string, unknown> = {}): string => `FINAL_RESULT: ${JSON.stringify({
    summary: "已完成最小修复，等待人工确认",
    key_points: ["请人工核对防抖阈值"],
    ...over,
  })}`;

  function stubVerify(w: Worker): void {
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
  }

  it("plan 在调查前调用、summary 在交付前调用，均只读无工具、严格 JSON", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, { agents: { roles: { coordinator: { model: "" } }, problems: [] } });
    stubVerify(w);
    stubP4({ openedSequence: [[], editedLogin] });
    const bug = makeBug();
    const calls: Array<Record<string, unknown>> = [];
    let coordinatorCalls = 0;
    // 本用例要断言 coordinator 自己收到什么参数，所以不用 spyAgentRun（它会把 coordinator 调用短路）。
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      if (opts.role === "coordinator") {
        coordinatorCalls += 1;
        return makeResult({ raw_output: coordinatorCalls === 1 ? planJson() : summaryJson() });
      }
      const otherCalls = calls.filter((call) => call.role !== "coordinator").length;
      return otherCalls === 1
        ? makeInvestigation("project:Login.ts")
        : makeResult({ changed_files: ["project:Login.ts"], summary: "实施完成：按 planned_files 做最小修复" });
    });

    await w.processBug(bug);

    // 调用顺序：coordinator(plan) → investigation → implementation → coordinator(summary)
    expect(calls.map((call) => call.role)).toEqual([
      "coordinator", "investigation", "implementation", "coordinator",
    ]);
    for (const call of calls.filter((item) => item.role === "coordinator")) {
      expect(call.tools).toEqual([]);                  // 无工具
      expect(call.sandboxMode).toBe("read-only");      // 只读
      expect(call.mcpServers).toEqual([]);             // 不挂任何 MCP
      expect(call.requiredMcpServers).toEqual([]);
    }
    // 计划建议只作为调查 prompt 的附加段，且措辞明确「仅供参考、非硬约束」
    const investigationCall = calls.find((call) => call.role === "investigation")!;
    const investigationPrompt = String(investigationCall.prompt);
    expect(investigationPrompt).toContain("调查计划建议（由 coordinator 角色只读生成，仅供参考，不是硬约束）");
    expect(investigationPrompt).toContain("Login.ts 的点击处理");
    // summary 只进交付描述：result.summary 的事实文字被保留
    expect(w.store.getJob(bug.id)?.generated_description).toContain("实施完成：按 planned_files 做最小修复");
    expect(w.store.getJob(bug.id)?.generated_description).toContain("协调者补充说明");
    // 审计：两次调用都被记录，带 role=coordinator；正文只落哈希（与 agent_input 同口径）
    const events = w.store.audit.attempts(bug.id).at(-1)!.events as Array<{ kind: string; payload: Record<string, unknown> }>;
    const planEvent = events.find((event) => event.kind === "coordinator_plan")!.payload;
    const summaryEvent = events.find((event) => event.kind === "coordinator_summary")!.payload;
    expect(planEvent).toMatchObject({ role: "coordinator", focus_areas: 1, risks: 1 });
    expect(String(planEvent.plan_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(summaryEvent).toMatchObject({ role: "coordinator", key_points: 1 });
    expect(String(summaryEvent.summary_hash)).toMatch(/^[0-9a-f]{64}$/);
    // 建议正文不得落进审计（正文只作为附加段落进 prompt / 交付描述）
    expect(JSON.stringify(events)).not.toContain("Login.ts 的点击处理");
    // Worker 保留硬决策：阶段推进仍由状态机决定，coordinator 不影响最终状态
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("plan 失败（超时 / 非法 JSON）降级：调查照常执行，prompt 里没有建议段", async () => {
    for (const failure of [new AgentTimeoutError("coordinator 超时", ""), null]) {
      const repo = tmpdir();
      fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
      const w = makeWorker(repo, { agents: { roles: { coordinator: { model: "" } }, problems: [] } });
      stubVerify(w);
      stubP4({ openedSequence: [[], editedLogin] });
      const bug = makeBug();
      let planSeen = false;
      const calls: Array<Record<string, unknown>> = [];
      vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
        calls.push(opts as unknown as Record<string, unknown>);
        if (opts.role === "coordinator") {
          if (!planSeen) {
            planSeen = true;
            if (failure) throw failure;
            return makeResult({ raw_output: "这不是 JSON" }); // 严格 JSON：非法输出同样降级
          }
          return makeResult({ raw_output: summaryJson() });
        }
        return calls.filter((call) => call.role === "investigation").length
          ? makeResult({ changed_files: ["project:Login.ts"], summary: "实施完成" })
          : makeInvestigation("project:Login.ts");
      });

      await w.processBug(bug);

      expect(calls.some((call) => call.role === "investigation")).toBe(true);
      const investigationPrompt = String(calls.find((call) => call.role === "investigation")!.prompt);
      expect(investigationPrompt).not.toContain("调查计划建议");
      expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
      const events = w.store.audit.attempts(bug.id).at(-1)!.events as Array<{ kind: string; payload: Record<string, unknown> }>;
      expect(events.find((event) => event.kind === "coordinator_plan")!.payload)
        .toMatchObject({ degraded: true });
      vi.restoreAllMocks();
    }
  });

  it("summary 失败降级：交付事实完全不变，只是没有附加说明", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, { agents: { roles: { coordinator: { model: "" } }, problems: [] } });
    stubVerify(w);
    stubP4({ openedSequence: [[], editedLogin] });
    const bug = makeBug();
    let planSeen = false;
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      if (opts.role === "coordinator") {
        if (!planSeen) { planSeen = true; return makeResult({ raw_output: planJson() }); }
        throw new AgentTimeoutError("coordinator 汇总超时", "");
      }
      const seen = vi.mocked(PiAgent.prototype.run).mock.calls
        .filter(([item]) => item.role === "investigation").length;
      return seen === 0
        ? makeInvestigation("project:Login.ts")
        : makeResult({ changed_files: ["project:Login.ts"], summary: "实施完成：按 planned_files 做最小修复" });
    });

    await w.processBug(bug);

    const description = String(w.store.getJob(bug.id)?.generated_description ?? "");
    expect(description).toContain("实施完成：按 planned_files 做最小修复");
    expect(description).not.toContain("协调者补充说明");
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("summary 不能覆盖测试 / 文件 / review 事实（自述通过也不改分类与文件清单）", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, {
      agents: { roles: { coordinator: { model: "" } }, problems: [] },
      review: { enabled: true, max_fix_rounds: 0 },
      quality: {
        admission: { min_score: 0, require_reproduction_signal: false, manual_keywords: [] },
        require_verification: true, max_changed_files: 8, max_diff_lines: 500,
      },
    });
    stubVerify(w);
    stubP4({ openedSequence: [[], editedLogin] });
    const bug = makeBug();
    let planSeen = false;
    let reviewSeen = false;
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      if (opts.role === "coordinator") {
        if (!planSeen) { planSeen = true; return makeResult({ raw_output: planJson() }); }
        // 事实是「验证未通过 + 评审未通过」，coordinator 却自称一切通过且文件更多
        return makeResult({ raw_output: summaryJson({ summary: "测试全部通过、评审通过、改了 9 个文件" }) });
      }
      if (opts.role === "review") {
        reviewSeen = true;
        return makeResult({ raw_output: JSON.stringify({
          approved: true, requirement_match: "pass", behavioral_evidence: "static_only",
          reuse_and_lifecycle: "pass", unverified_items: [], note: "已检查", findings: [],
        }) });
      }
      const investigation = vi.mocked(PiAgent.prototype.run).mock.calls
        .filter(([item]) => item.role === "investigation").length === 0;
      return investigation
        ? makeInvestigation("project:Login.ts")
        : makeResult({ changed_files: ["project:Login.ts"], summary: "实施完成" });
    });

    await w.processBug(bug);

    expect(reviewSeen).toBe(true);
    // 硬事实不受 coordinator 文字影响：分类、文件清单、交付描述里的真实改动都保持原样
    const job = w.store.getJob(bug.id)!;
    expect(job.agent_state).toBe("review_pending");
    expect(String(job.files)).toContain("project:Login.ts");
    expect(String(job.generated_description)).toContain("实施完成");
    expect(String(job.generated_description)).not.toContain("改了 9 个文件");
  });

  it("未配置 agents.roles.coordinator 时不新增任何调用（与改造前逐字一致）", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    // 显式留空 roles：这是旧 config.yaml 的默认形态，coordinator 属于「新增调用点」，必须 opt-in。
    const w = makeWorker(repo, { agents: { roles: {}, problems: [] } });
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    stubP4({ openedSequence: [[], editedLogin] });
    const bug = makeBug();
    const roles: Array<string | undefined> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      roles.push(opts.role);
      return roles.filter((role) => role !== "coordinator").length === 1
        ? makeInvestigation("project:Login.ts")
        : makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });

    await w.processBug(bug);

    expect(roles).toEqual(["investigation", "implementation"]);
    const description = String(w.store.getJob(bug.id)?.generated_description ?? "");
    expect(description).not.toContain("协调者补充说明");
    expect(description).not.toContain("调查计划建议");
    const events = w.store.audit.attempts(bug.id).at(-1)!.events as Array<{ kind: string }>;
    expect(events.some((event) => event.kind === "coordinator_plan")).toBe(false);
    expect(events.some((event) => event.kind === "coordinator_summary")).toBe(false);
  });

  it("人工取消必须传播：coordinator 被取消不降级成「没有建议」，也不继续跑调查", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, { agents: { roles: { coordinator: { model: "" } }, problems: [] } });
    stubP4();
    const bug = makeBug();
    const roles: Array<string | undefined> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      roles.push(opts.role);
      if (opts.role === "coordinator") throw new AgentCancelledError("Agent 调用被人工取消: pi");
      return makeInvestigation("project:Login.ts");
    });

    // 取消传播 ≠ 从 processBug 抛异常：AgentCancelledError 由 Worker 内部统一收口
    // （中断标志 + 整单终止），所以这里必须正常返回，且绝不能降级成「没有建议」继续跑调查。
    await w.processBug(bug);

    expect(roles).toEqual(["coordinator"]);
    // 不是降级：取消不落 degraded 事件（降级只覆盖超时/异常退出/非法 JSON）
    const events = w.store.audit.attempts(bug.id).at(-1)!.events as Array<{ kind: string }>;
    expect(events.some((event) => event.kind === "coordinator_plan")).toBe(false);
    // 整单终止：留下中断记录并回到待处理队列，等待人工恢复
    expect(w.store.listEvents(bug.id).some((event) => /人工中断/.test(String(event.msg)))).toBe(true);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 管理台：当前阶段 + 该阶段实际生效的模型
// ---------------------------------------------------------------------------
describe("管理台当前阶段与阶段模型", () => {
  it("空闲时 current_stage 为空（后端空串 → 前端「—」），不会拿上一单或 job.model 充数", () => {
    const w = makeWorker(tmpdir(), {
      agents: { roles: { implementation: { model: "impl-model" } }, problems: [] },
    });

    expect(w.status()).toMatchObject({
      current_bug: null,
      current_stage: {
        current_stage: null, current_stage_label: "", current_role: null, current_model: "",
      },
    });
    expect(w.currentStageInfo()).toEqual({
      current_stage: null, current_stage_label: "", current_role: null, current_model: "",
    });
  });

  it("阶段随编排推进切换：阶段模型与真实调用参数同源；无模型阶段（验证）显示为空串", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, {
      agents: {
        roles: { investigation: { model: "inv-model" }, implementation: { model: "impl-model" } },
        problems: [],
      },
    });
    const bug = makeBug();
    const stages: Array<Record<string, unknown>> = [];
    const recordStage = (): Record<string, unknown> => ({ ...w.status().current_stage as Record<string, unknown> });
    spyAgentRun(async (opts) => {
      if (opts.role !== "coordinator") stages.push({ ...recordStage(), role: opts.role, model_arg: opts.model ?? "" });
      if (stages.length === 1) return makeInvestigation("project:Login.ts");
      return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });
    // 验证门由 core.test.ts 覆盖；这里只关心阶段切换，直接喂入已通过的验证结果，
    // 并在验证门入口记录一次状态条内容（机器验证阶段不调用模型）。
    let duringVerification: Record<string, unknown> = {};
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => {
      duringVerification = recordStage();
      return {
        opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
        summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
      };
    };
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    expect(stages.map((s) => [s.current_stage, s.current_stage_label, s.current_role, s.current_model])).toEqual([
      ["investigation", "只读调查", "investigation", "gateway/inv-model"],
      ["implementation", "实施编码", "implementation", "gateway/impl-model"],
    ]);
    // 阶段模型与真实调用参数同源：不会出现「显示的模型 ≠ 调用的模型」
    expect(stages[0].model_arg).toBe("gateway/inv-model");
    expect(stages[1].model_arg).toBe("gateway/impl-model");
    // 机器验证不调用模型：显示「—」（空串 + 空角色），不沿用上一阶段的模型
    expect(duringVerification).toEqual({
      current_stage: "verification", current_stage_label: "机器验证",
      current_role: null, current_model: "",
    });
    // processBug 自身收口（不依赖 processNext）：直接调用入口也一样回到「—」
    expect(w.status().current_stage).toMatchObject({
      current_stage: null, current_stage_label: "", current_role: null, current_model: "",
    });
    expect(await w.bugDetailForWeb(bug.id)).not.toHaveProperty("current_stage");
  });

  it("无角色覆盖时阶段模型回落 pi.provider 默认模型", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, { agents: { roles: { coordinator: { model: "" } }, problems: [] } });
    const bug = makeBug();
    const stages: Array<Record<string, unknown>> = [];
    spyAgentRun(async (opts) => {
      if (opts.role !== "coordinator") stages.push({ ...w.status().current_stage as Record<string, unknown> });
      if (stages.length === 1) return makeInvestigation("project:Login.ts");
      return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    expect(stages.map((s) => s.current_model)).toEqual(["gateway/fix-model", "gateway/fix-model"]);
    // 阶段角色同样来自解析：没有角色覆盖时仍是该阶段自己的角色（不是 coordinator）
    expect(stages.map((s) => s.current_role)).toEqual(["investigation", "implementation"]);
  });

  it("coordinator 调用期间状态条显示角色 coordinator（阶段标签不变），结束后还原为阶段角色", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, {
      agents: { roles: { coordinator: { model: "coord-model" } }, problems: [] },
    });
    const bug = makeBug();
    const seen: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      const stage = w.status().current_stage as Record<string, unknown>;
      seen.push({
        role: opts.role, stage: stage.current_stage,
        stage_role: stage.current_role, model: stage.current_model,
      });
      if (opts.role === "coordinator") return makeResult({ raw_output: "" }); // 降级，不影响结论
      const others = seen.filter((item) => item.role !== "coordinator").length;
      return others === 1
        ? makeInvestigation("project:Login.ts")
        : makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    const coordinatorCalls = seen.filter((item) => item.role === "coordinator");
    // 两次 coordinator 调用：角色显示 coordinator，模型显示 coordinator 自己的模型
    expect(coordinatorCalls.map((s) => [s.stage_role, s.model])).toEqual([
      ["coordinator", "gateway/coord-model"],
      ["coordinator", "gateway/coord-model"],
    ]);
    // 阶段标签仍是所属阶段（不新增 phase）：第一次调用落在「准入评估」之后、调查之前
    expect(coordinatorCalls[0].stage).toBe("admission");
    // 还原：后续阶段调用显示的是阶段自己的角色与模型，不残留 coordinator
    expect(seen.filter((item) => item.role !== "coordinator")
      .map((s) => [s.role, s.stage_role, s.model])).toEqual([
      ["investigation", "investigation", "gateway/fix-model"],
      ["implementation", "implementation", "gateway/fix-model"],
    ]);
    expect(w.status().current_stage).toMatchObject({
      current_stage: null, current_role: null, current_model: "",
    });
  });

  it("调查达到预算后的 recovery 收尾：阶段标签不变，模型切到 recovery 后再还原", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, {
      agents: {
        roles: { investigation: { model: "inv-model" }, recovery: { model: "recovery-model" } },
        problems: [],
      },
    });
    const bug = makeBug();
    const calls: Array<{ role?: string; stage?: unknown; label?: unknown; shown?: unknown; model?: unknown }> = [];
    spyAgentRun(async (opts) => {
      const stage = w.status().current_stage as Record<string, unknown>;
      if (opts.role !== "coordinator") calls.push({ role: opts.role, stage: stage.current_stage, label: stage.current_stage_label, shown: stage.current_role, model: stage.current_model });
      if (calls.length === 1) {
        // 调查一次就耗尽预算：触发无工具 recovery 收尾
        throw new AgentInvestigationLimitError("调查达到工具预算", "工具 read: Login.ts");
      }
      if (calls.length === 2) return makeInvestigation("project:Login.ts");
      return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    expect(calls.map((c) => [c.role, c.stage, c.label, c.shown, c.model])).toEqual([
      // 主调查：调查阶段 + 调查角色 + 调查模型
      ["investigation", "investigation", "只读调查", "investigation", "gateway/inv-model"],
      // recovery 收尾：阶段标签仍是「只读调查」，角色与模型都已切到真正在跑的 recovery
      ["recovery", "investigation", "只读调查", "recovery", "gateway/recovery-model"],
      // 收尾结束回到实施阶段：角色与模型都还原为实施角色（不是残留的 recovery）
      ["implementation", "implementation", "实施编码", "implementation", "gateway/impl-model"],
    ]);
    expect(w.status().current_stage).toMatchObject({ current_stage: null, current_role: null, current_model: "" });
  });

  it("补充核查达到预算后的 recovery 收尾：模型同样切到 recovery 并还原", async () => {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, "Login.ts"), "export const login = true;\n");
    const w = makeWorker(repo, {
      agents: {
        roles: { investigation: { model: "inv-model" }, recovery: { model: "recovery-model" } },
        problems: [],
      },
    });
    const bug = makeBug();
    const calls: Array<{ role?: string; stage?: unknown; label?: unknown; model?: unknown }> = [];
    spyAgentRun(async (opts) => {
      const stage = w.status().current_stage as Record<string, unknown>;
      if (opts.role !== "coordinator") calls.push({ role: opts.role, stage: stage.current_stage, label: stage.current_stage_label, model: stage.current_model });
      // 1) 主调查成功但不完整（缺少 repair_contract / 根因）→ 进入补充核查轮
      if (calls.length === 1) {
        return makeResult({ raw_output: 'FINAL_RESULT: {"evidence":["[观察] Login.ts:1"],"planned_files":["project:Login.ts"],"confidence":0.6}' });
      }
      // 2) 补充核查轮耗尽工具预算 → 触发第二次无工具 recovery 收尾
      if (calls.length === 2) {
        throw new AgentInvestigationLimitError("补充核查达到工具预算", "工具 grep: login");
      }
      if (calls.length === 3) return makeInvestigation("project:Login.ts");
      return makeResult({ changed_files: ["project:Login.ts"], summary: "完成修复" });
    });
    (w as unknown as { verifyCandidate: unknown }).verifyCandidate = async () => ({
      opened: editedLogin, gitFiles: [], diff: "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
      summary: "验证通过", verified: true, behavior: { checks: [] }, pipelines: [],
    });
    stubP4({ openedSequence: [[], editedLogin] });

    await w.processBug(bug);

    expect(calls.map((c) => [c.role, c.stage, c.label, c.model])).toEqual([
      // 主调查不完整：仍是调查角色 + 调查模型
      ["investigation", "investigation", "只读调查", "gateway/inv-model"],
      // 补充核查轮：角色回到 investigation，模型还原为调查模型（不是残留的 recovery 模型）
      ["investigation", "investigation", "只读调查", "gateway/inv-model"],
      // 补充核查达预算后的 recovery 收尾：阶段标签不变，模型切到真正在跑的 recovery 模型
      ["recovery", "investigation", "只读调查", "gateway/recovery-model"],
      // 收尾结束进入实施阶段：模型还原为实施角色模型
      ["implementation", "implementation", "实施编码", "gateway/impl-model"],
    ]);
    expect(w.status().current_stage).toMatchObject({ current_stage: null, current_model: "" });
  });
});

// ---------------------------------------------------------------------------
// 展示口径：实际调用模型（审计 agent_input） vs 默认回退模型（pi.provider）
// ---------------------------------------------------------------------------
describe("任务详情的模型口径", () => {
  it("actual_models 只来自审计 agent_input：按 role+model 去重计数，不拿默认回退模型充数", async () => {
    const w = makeWorker(tmpdir(), {
      agents: { roles: { investigation: { model: "inv-model" } }, problems: [] },
    });
    const bug = makeBug();
    w.store.upsertJob(bug, { agent_state: "candidate", agent: "pi", model: "gateway/fix-model" });
    stubMyBugs(w, [bug]);
    const attemptId = w.store.audit.begin({
      bug_id: bug.id, workspace_id: "111", input: {}, metadata: { default_model: "gateway/fix-model" },
    });
    w.store.audit.event(attemptId, "agent", {
      phase: "investigation", kind: "agent_input", role: "investigation", model: "gateway/inv-model",
    });
    w.store.audit.event(attemptId, "agent", {
      phase: "investigation", kind: "agent_input", role: "recovery", model: "gateway/fix-model",
    });
    w.store.audit.event(attemptId, "agent", {
      phase: "implementation", kind: "agent_input", role: "recovery", model: "gateway/fix-model",
    });
    // 非 agent_input 的事件（agent_usage 等）不参与「实际调用模型」口径
    w.store.audit.event(attemptId, "agent", {
      phase: "review", kind: "agent_usage", role: "review", model: "gateway/not-a-call",
    });
    w.store.audit.event(attemptId, "finished", { state: "candidate" });

    const detail = (await w.bugDetailForWeb(bug.id))!;
    expect(detail.actual_models).toEqual([
      { role: "investigation", model: "gateway/inv-model", calls: 1 },
      { role: "recovery", model: "gateway/fix-model", calls: 2 },
    ]);
    // 默认回退模型单独给出（兼容字段 model + 新字段 default_model），不冒充实际调用
    expect(detail.default_model).toBe("gateway/fix-model");
    expect(detail.model).toBe("gateway/fix-model");
    // 角色模型摘要与审计一致：调查角色用角色模型，未配置的角色走默认回退
    const roleEntry = (role: string) => (detail.role_models as Array<Record<string, unknown>>)
      .find((entry) => entry.role === role);
    expect(roleEntry("investigation"))
      .toMatchObject({ configured: true, effective_model: "gateway/inv-model", uses_default_model: false });
    expect(roleEntry("recovery"))
      .toMatchObject({ configured: false, effective_model: "gateway/fix-model", uses_default_model: true });
  });

  it("没有审计记录时 actual_models 为空数组：不声称任何模型被调用过", async () => {
    const w = makeWorker(tmpdir());
    const bug = makeBug();
    w.store.upsertJob(bug, { agent_state: "candidate", agent: "pi", model: "gateway/fix-model" });
    stubMyBugs(w, [bug]);

    const detail = (await w.bugDetailForWeb(bug.id))!;
    expect(detail.actual_models).toEqual([]);
    expect(detail.default_model).toBe("gateway/fix-model");
  });

  it("真实 PiAgent 的 agent_input（spawn 之前落库）就是 actual_models 的来源", async () => {
    const d = tmpdir();
    const roles = { roles: { investigation: { model: "inv-model" } }, problems: [] };
    const events: Array<Record<string, unknown>> = [];
    await runToleratingSpawnFailure(() => new PiAgent(makeConfig({ agents: roles })).run({
      prompt: "x", repoDir: d, role: "investigation", onAudit: (event) => events.push(event),
    }));
    const input = events.find((event) => event.kind === "agent_input")!;
    // 本沙箱禁止带管道 stdio 的子进程，spawn 会失败；但 agent_input 在 spawn 之前就已产生。
    expect(input).toMatchObject({ role: "investigation", model: "gateway/inv-model" });

    const w = makeWorker(tmpdir(), { agents: roles });
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    const attemptId = w.store.audit.begin({
      bug_id: bug.id, workspace_id: "111", input: {}, metadata: {},
    });
    w.store.audit.event(attemptId, "agent", { phase: "investigation", ...input });
    w.store.audit.event(attemptId, "finished", { state: "candidate" });

    const detail = (await w.bugDetailForWeb(bug.id))!;
    expect(detail.actual_models).toEqual([
      { role: "investigation", model: "gateway/inv-model", calls: 1 },
    ]);
  });

  it("actualModelUses 对空输入与未标注角色的历史调用都保持诚实", () => {
    expect(actualModelUses([])).toEqual([]);
    expect(actualModelUses([{ events: [] } as never])).toEqual([]);
    // 历史调用没有 role：记为 null，不硬塞成某个角色
    expect(actualModelUses([{
      events: [{ kind: "agent", payload: { kind: "agent_input", model: "gateway/x" } }],
    } as never])).toEqual([{ role: null, model: "gateway/x", calls: 1 }]);
  });
});
