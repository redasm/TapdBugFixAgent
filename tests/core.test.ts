/** 核心逻辑测试（纯本地，无网络/p4 依赖）——由 tests/test_core.py 移植。 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { bugFromDict, dumps } from "../src/models.js";
import type { AgentResult, Bug } from "../src/models.js";
import { buildDescription, bugShortId } from "../src/descgen.js";
import {
  DEFAULT_PRIORITY_WEIGHT,
  applySettingsOverrides,
  loadConfig,
  priorityRank,
  readSettingsOverrides,
  saveSettingsOverrides,
  validateConfig,
} from "../src/config.js";
import type { Config, RepoConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { ensureP4IgnoreFile, GENERATED_P4IGNORE, isP4ConnectionFailure, P4CancelledError, P4Client, P4ConnectionError, P4Error, P4SyncTimeoutError, p4EnvFromConfig, p4PathIgnored, setSpecField } from "../src/p4.js";
import type { OpenedFile } from "../src/p4.js";
import { VerificationError, checkAndPrepareP4, p4ReconcileTargets } from "../src/verify.js";
import {
  AgentCancelledError,
  AgentInfrastructureError,
  AgentRuntimeError,
  AgentTimeoutError,
  CancelEvent,
  PiAgent,
  effectivePiModel,
  ensurePiModels,
  extractFinalJson,
  extractFinalText,
  formatRetryEvidence,
  progressFromLine,
  resultFromOutput,
} from "../src/agent.js";
import { Worker } from "../src/worker.js";
import { TapdMcpClient } from "../src/tapdMcp.js";
import {
  createCodingAgent,
  effectiveAgentModel,
  effectiveReviewModel,
  selectedAgentBackend,
} from "../src/agentBackend.js";
import {
  CodexAgent,
  CommandExecutionGuard,
  codexOutputSchema,
  codexThreadOptions,
  ensureCodexModelCatalog,
  progressFromCodexEvent,
} from "../src/codexAgent.js";
import {
  codexMcpConfig,
  configuredManualKeywords,
  inspectMcpServer,
  mcpToolGuidance,
  parseMcpServers,
  probeMcpServer,
  resolveMcpServers,
} from "../src/mcpServers.js";
import { assessFixability } from "../src/quality.js";
import { buildFixBranchName, GitWorkspace } from "../src/git.js";

// mock MCP SDK：给 tapdMcp 回归测试用（不发起真实子进程/网络）
const mcpMockState = vi.hoisted(() => ({
  tools: [] as Array<Record<string, unknown>>,
  callResult: { content: [] as Array<Record<string, unknown>> },
  calledTools: [] as string[],
  closed: 0,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: unknown[] }> {
      return { tools: mcpMockState.tools };
    }
    async callTool(input: { name: string }): Promise<unknown> {
      mcpMockState.calledTools.push(input.name);
      return mcpMockState.callResult;
    }
    async close(): Promise<void> { mcpMockState.closed += 1; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function makeBug(over: Record<string, unknown> = {}): Bug {
  const data: Record<string, unknown> = {
    id: "1152729922001234007", // 字符串：>2^53 的大整数，Number 字面量会丢精度
    workspace_id: "1152729922",
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

function makeResult(over: Partial<AgentResult> = {}): AgentResult {
  return {
    ok: true,
    summary: "",
    changed_files: [],
    manual_assets: [],
    blocked_reasons: [],
    exit_code: 0,
    log: "",
    raw_output: "",
    ...over,
  };
}

function makeInvestigation(file: string): AgentResult {
  return makeResult({
    raw_output: `FINAL_RESULT: {"root_cause":"测试根因","evidence":["[观察] ${file}:1","[推断] 根因由该观察事实支持"],"reproduction":{"command":"","before":"复现失败"},"planned_files":["${file}"],"confidence":0.9,"blocked_reasons":[]}`,
  });
}

function makeConfig(): Config {
  return {
    max_bugs_per_run: 10,
    max_attempts: 1,
    agent_timeout_s: 900,
    agent: { backend: "pi" },
    codex: {
      model: "",
      reasoning_effort: "high",
      approval_policy: "never",
      network_access: false,
      base_url: "",
      api_key_env: "OPENAI_API_KEY",
      codex_path: "",
      model_catalog_json: "",
      context_window: 0,
      auto_compact_token_limit: 0,
    },
    mcp_servers: {},
    quality: {
      admission: {
        min_score: 0,
        require_reproduction_signal: false,
        manual_keywords: [],
        high_risk_keywords: [],
      },
      require_verification: false,
      max_changed_files: 8,
      max_diff_lines: 500,
    },
    review: { enabled: false, backend: "", max_fix_rounds: 0, model: "" },
    exclude_status: ["resolved", "closed", "rejected"],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [],
    pi: { provider: undefined },
    p4: {},
    web: {},
    tapd: {},
    config_path: "",
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tapd-test-"));
}

/** 建一个带一个 workspace（repos 可注入）的 worker。 */
function makeWorker(repos: RepoConfig[] = []): Worker {
  const store = new StateStore(":memory:");
  const cfg = makeConfig();
  cfg.workspaces = [
    {
      workspace_id: "111",
      owner: "me",
      repos,
      default_repo: "",
    },
  ];
  return new Worker(cfg, store);
}

class FakeTapd {
  private bugs: Bug[];
  constructor(bugs: Bug[] = []) {
    this.bugs = bugs;
  }
  async getBug(bugId: string): Promise<Bug> {
    const b = this.bugs.find((x) => x.id === bugId);
    if (!b) throw new Error("not found");
    return b;
  }
}

/** 把假 tapd 塞进 worker 的客户端缓存（backend=rest 时 key = workspace_id）。 */
function stubTapd(w: Worker, fake: FakeTapd): void {
  (w as unknown as { clients: Record<string, unknown> }).clients["111"] = fake;
}

function stubMyBugs(w: Worker, bugs: Bug[]): void {
  (w as unknown as { fetchMyBugs: () => Promise<Bug[]> }).fetchMyBugs = async () => bugs;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// descgen
// ---------------------------------------------------------------------------
describe("descgen", () => {
  it("build_description", () => {
    const bug = makeBug();
    const result = makeResult({
      summary: "修复了空指针，增加判空。",
      changed_files: ["src/login.cpp"],
      manual_assets: [{ path: "Assets/login.prefab", reason: "Unity 二进制资源" }],
    });
    const desc = buildDescription(bug, result, "pytest 1 passed");
    expect(desc).toContain("【b1234007】登录页偶现崩溃"); // 首行 = swarm 校验格式（短号）
    expect(desc).toContain("登录页偶现崩溃");
    expect(desc).toContain("需人工处理的资源");
    expect(desc).toContain("Unity 二进制资源");
    expect(desc).toContain("pytest 1 passed");
  });

  it("manual_only 不含修改文件段", () => {
    const bug = makeBug();
    const result = makeResult({
      summary: "无代码改动",
      manual_assets: [{ path: "a.xlsx", reason: "表格" }],
    });
    const desc = buildDescription(bug, result);
    expect(desc).not.toContain("修改文件:");
    expect(desc).toContain("a.xlsx");
  });

  it("bugShortId：真实 id = 1+workspace+前导零序号 → 去前导零短号", () => {
    // 真实形态：workspace 52729922，id 1152729922·001257090 → b1257090
    expect(bugShortId({ id: "1152729922001257090", workspace_id: "52729922" })).toBe("1257090");
    // 序号无前导零
    expect(bugShortId({ id: "1152729922001256834", workspace_id: "52729922" })).toBe("1256834");
  });

  it("bugShortId：前缀不匹配（异常数据）→ 回退末 7 位去前导零", () => {
    expect(bugShortId({ id: "1152729922001234007", workspace_id: "1152729922" })).toBe("1234007");
    expect(bugShortId({ id: "99000123", workspace_id: "52729922" })).toBe("9000123"); // 末 7 位无前导零
    // 全零/空保底：返回完整 id，不产生 b 后空串
    expect(bugShortId({ id: "0", workspace_id: "52729922" })).toBe("0");
  });

  it("bugShortId + 标题 = Tapd「复制Bug单信息」的文本格式（真实单验证）", () => {
    // 真实单：id 1152729922001257090，标题自带【模块】前缀（swarm 校验用）
    const bug = makeBug({
      id: "1152729922001257090",
      workspace_id: "52729922",
      title: "【爬塔二期】【排行榜】排名显示错误，预期显示13实际显示了9",
    });
    const desc = buildDescription(bug, makeResult({ summary: "修复" }));
    expect(desc.split("\n")[0]).toBe("【b1257090】【爬塔二期】【排行榜】排名显示错误，预期显示13实际显示了9");
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
describe("config", () => {
  it("priority_rank", () => {
    const cfg = makeConfig();
    expect(priorityRank(cfg, makeBug({ priority: "1" }))).toBe(0);
    expect(priorityRank(cfg, makeBug({ priority: "4" }))).toBe(3);
    // 优先级与 label 都未知 -> 排最后
    expect(priorityRank(cfg, makeBug({ priority: "未知值", priority_label: "" }))).toBeGreaterThan(3);
  });

  it("load_from_yaml", () => {
    const d = tmpdir();
    const cfgPath = path.join(d, "config.yaml");
    fs.writeFileSync(
      cfgPath,
      `workspaces:
  - workspace_id: "111"
    owner: me
    repos:
      - name: p
        path: "."
        verify_cmds: ["echo ok"]
priority_weight:
  高: 0
  低: 1
`,
      "utf-8",
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.workspaces[0].workspace_id).toBe("111");
    expect(cfg.workspaces[0].repos[0].name).toBe("p");
    expect(cfg.priority_weight["低"]).toBe(1);
    expect(cfg.agent.backend).toBe("pi");
    expect(cfg.codex.reasoning_effort).toBe("high");
  });

  it("加载 Codex 后端和独立 Reviewer 后端", () => {
    const dir = tmpdir();
    const cfgPath = path.join(dir, "c.yaml");
    fs.writeFileSync(cfgPath, `agent:\n  backend: codex\ncodex:\n  model: gpt-test\n  reasoning_effort: xhigh\nreview:\n  backend: pi\n`, "utf-8");
    const cfg = loadConfig(cfgPath);
    expect(cfg.agent.backend).toBe("codex");
    expect(cfg.codex.model).toBe("gpt-test");
    expect(cfg.codex.reasoning_effort).toBe("xhigh");
    expect(cfg.review.backend).toBe("pi");
  });

  it("loadConfig 拒绝旧 pi.model 字段", () => {
    const dir = tmpdir();
    const cfgPath = path.join(dir, "c.yaml");
    fs.writeFileSync(
      cfgPath,
      `pi:
  model: "kuro/legacy"
  provider:
    id: "kuro"
    base_url: "https://ai-gateway.kurogames.com"
    api_key_env: "ANTHROPIC_AUTH_TOKEN"
    auth_header: true
    model_id: "deepseek-v4-flash"
`,
      "utf-8",
    );
    expect(() => loadConfig(cfgPath)).toThrow(/不再支持的配置字段.*pi\.model/);
  });

  it("loadConfig 解析 pi.skill_dirs（团队共享 skill 目录）", () => {
    const dir = tmpdir();
    const cfgPath = path.join(dir, "c.yaml");
    fs.writeFileSync(
      cfgPath,
      `pi:
  skill_dirs:
    - ".agents/skills"
    - "D:/shared/skills"
`,
      "utf-8",
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.pi.skill_dirs).toEqual([".agents/skills", "D:/shared/skills"]);
  });

  it("loadConfig 解析项目下的多个 Git 附加目录", () => {
    const root = tmpdir();
    const project = path.join(root, "project");
    const engine = path.join(root, "engine");
    fs.mkdirSync(project);
    fs.mkdirSync(engine);
    const cfgPath = path.join(root, "config.yaml");
    fs.writeFileSync(cfgPath, `workspaces:
  - workspace_id: "111"
    owner: yangfan
    default_repo: game
    repos:
      - name: game
        path: ${JSON.stringify(project)}
        ignore_paths:
          - Config/
          - "**/Saved/"
        preflight_reconcile: once
        verify_cmds: []
        additional_dirs:
          - name: engine
            path: ${JSON.stringify(engine)}
            vcs: git
            base_branch: branch_0.7.0
            author: yangfan
            ignore_paths:
              - Engine/Binaries/Win64/UnrealBuildAccelerator/
            verify_cmds: ["npm test"]
`, "utf-8");

    const cfg = loadConfig(cfgPath);

    expect(cfg.workspaces[0].repos[0].ignore_paths).toEqual(["Config/", "**/Saved/"]);
    expect(cfg.workspaces[0].repos[0].preflight_reconcile).toBe("once");
    expect(cfg.workspaces[0].repos[0].additional_dirs).toEqual([{
      name: "engine",
      path: engine,
      vcs: "git",
      base_branch: "branch_0.7.0",
      author: "yangfan",
      ignore_paths: ["Engine/Binaries/Win64/UnrealBuildAccelerator/"],
      verify_cmds: ["npm test"],
    }]);
  });

  it("validate 报告缺少凭据", () => {
    const cfg = makeConfig();
    const problems = validateConfig(cfg);
    expect(problems.some((p) => p.includes("TAPD"))).toBe(true);
  });
});

describe("Agent 后端选择", () => {
  it("默认保持 Pi，并可切换到 Codex", () => {
    const cfg = makeConfig();
    expect(selectedAgentBackend(cfg)).toBe("pi");
    expect(createCodingAgent(cfg)).toBeInstanceOf(PiAgent);
    cfg.agent.backend = "codex";
    cfg.codex.model = "gpt-test";
    expect(selectedAgentBackend(cfg)).toBe("codex");
    expect(effectiveAgentModel(cfg)).toBe("gpt-test");
    expect(createCodingAgent(cfg)).toBeInstanceOf(CodexAgent);
  });

  it("Pi Reviewer 的裸模型名自动继承 provider 前缀", () => {
    const cfg = makeConfig();
    cfg.pi.provider = {
      id: "kuro", base_url: "https://example.test", api_key_env: "TEST_KEY",
      auth_header: true, model_id: "deepseek-v4-pro", reasoning: true,
      context_window: 1000000, max_tokens: 32000, skill_dirs: [],
    };
    cfg.review.model = "deepseek-v4-pro";
    expect(effectiveReviewModel(cfg, "pi")).toBe("kuro/deepseek-v4-pro");
    cfg.review.model = "other/model";
    expect(effectiveReviewModel(cfg, "pi")).toBe("other/model");
  });

  it("Codex 事件转换为可读进度", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "1",
        type: "file_change",
        status: "completed",
        changes: [{ path: "src/a.ts", kind: "update" }],
      },
    } as never);
    expect(progress).toContain("src/a.ts");
  });

  it("Codex MCP 工具失败进度包含 SDK 返回的错误正文", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "unreal_mcp",
        tool: "read_mcp_resource",
        arguments: { uri: "ping" },
        status: "failed",
        error: { message: "Invalid request parameters" },
      },
    } as never);
    expect(progress).toContain("unreal_mcp/read_mcp_resource");
    expect(progress).toContain("Invalid request parameters");
  });

  it("Codex 命令失败进度包含 exit code 和输出尾部", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "git status --short",
        aggregated_output: "fatal: not a git repository",
        exit_code: 128,
        status: "failed",
      },
    } as never);
    expect(progress).toContain("命令失败（exit 128）");
    expect(progress).toContain("not a git repository");
  });

  it("Codex 将 rg exit 1 且无输出显示为未命中而不是失败", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "powershell.exe -Command 'rg -n missing Source'",
        aggregated_output: "",
        exit_code: 1,
        status: "failed",
      },
    } as never);
    expect(progress).toContain("搜索未命中");
    expect(progress).not.toContain("命令失败");
  });

  it("Codex 将 rg 管道提前结束造成的 exit 1 显示为已有结果", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-3",
        type: "command_execution",
        command: "rg -n WildEvent . | Select-Object -First 20",
        aggregated_output: "Source/WildEvent.ts:42:class WildEvent",
        exit_code: 1,
        status: "failed",
      },
    } as never);
    expect(progress).toContain("搜索已返回结果");
    expect(progress).not.toContain("命令失败");
  });

  it("Codex 保留 rg 路径错误为真实命令失败", () => {
    const progress = progressFromCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-4",
        type: "command_execution",
        command: "rg -n WildEvent MissingDir",
        aggregated_output: "rg: MissingDir: 系统找不到指定的文件。 (os error 2)",
        exit_code: 1,
        status: "failed",
      },
    } as never);
    expect(progress).toContain("命令失败（exit 1）");
    expect(progress).toContain("系统找不到指定的文件");
  });

  it("Codex 线程接收去重排序后的 additionalDirectories", () => {
    const cfg = makeConfig();
    const options = codexThreadOptions({
      prompt: "fix",
      repoDir: "C:\\project",
      additionalDirs: ["C:\\engine-b", "C:\\engine-a", "C:\\engine-b"],
      timeoutS: 10,
    }, cfg.codex, "workspace-write");

    expect(options.workingDirectory).toBe("C:\\project");
    expect(options.additionalDirectories).toEqual(["C:\\engine-a", "C:\\engine-b"]);
  });

  it("自定义 Codex 网关禁用原生 outputSchema，避免工具调用被提前终止", () => {
    const cfg = makeConfig();
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const opts = { prompt: "x", repoDir: "C:\\project", timeoutS: 60, outputSchema: schema };

    cfg.codex.base_url = "https://gateway.example.com";
    expect(codexOutputSchema(opts, cfg.codex)).toBeUndefined();

    cfg.codex.base_url = "";
    expect(codexOutputSchema(opts, cfg.codex)).toBe(schema);
  });

  it("Codex 调查守卫阻止重复命令和超出命令预算", () => {
    const repeated = new CommandExecutionGuard(10, 2);
    repeated.observe("rg -n Foo Source");
    repeated.observe("  RG   -n foo source ");
    expect(() => repeated.observe("rg -n Foo Source")).toThrow(/重复超过 2 次/);

    const budget = new CommandExecutionGuard(2, 10);
    budget.observe("one");
    budget.observe("two");
    expect(() => budget.observe("three")).toThrow(/超过预算 2 次/);
  });

  it("自定义 Codex 网关不自动套用 GPT 模型目录", () => {
    const cfg = makeConfig();
    cfg.codex.model = "glm-5.3";
    cfg.codex.base_url = "https://gateway.example.com";
    cfg.codex.context_window = 1_000_000;
    expect(ensureCodexModelCatalog(cfg, cfg.codex.model)).toBeUndefined();

    cfg.codex.model_catalog_json = "{agent}/models/glm.json";
    expect(ensureCodexModelCatalog(cfg, cfg.codex.model)).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "models/glm.json"),
    );
  });
});

describe("Git 附加工作区", () => {
  it("按主分支、作者和秒级时间生成分支名", () => {
    expect(buildFixBranchName(
      "branch_0.7.0", "yangfan", new Date(2026, 6, 7, 17, 17, 30),
    )).toBe("branch_0.7.0_yangfan20260707171730");
  });

  it("创建修复分支、本地提交并切回主分支", async () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-b", "branch_0.7.0"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "engine.txt"), "before\n");
    execFileSync("git", ["add", "engine.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    const workspace = new GitWorkspace(repo);
    const session = await workspace.prepareBranch(
      "branch_0.7.0", "yangfan", new Date(2026, 6, 7, 17, 17, 30),
    );
    fs.writeFileSync(path.join(repo, "engine.txt"), "after\n");

    const result = await workspace.finalize(session, "fix engine bug");

    expect(result?.branch).toBe("branch_0.7.0_yangfan20260707171730");
    expect(result?.files).toEqual(["engine.txt"]);
    expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo }).toString().trim())
      .toBe("branch_0.7.0");
    expect(execFileSync("git", ["show", `${result?.commit}:engine.txt`], { cwd: repo }).toString())
      .toBe("after\n");
  });

  it("失败回滚只清理本次创建的分支", async () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
    const workspace = new GitWorkspace(repo);
    const session = await workspace.prepareBranch("main", "yangfan", new Date(2026, 0, 2, 3, 4, 5));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "temporary\n");

    await workspace.rollback(session);

    expect(execFileSync("git", ["branch", "--show-current"], { cwd: repo }).toString().trim()).toBe("main");
    expect(execFileSync("git", ["branch", "--list", session.branch], { cwd: repo }).toString().trim()).toBe("");
    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"))
      .toBe("base\n");
    expect(fs.existsSync(path.join(repo, "new.txt"))).toBe(false);
  });

  it("忽略已跟踪和未跟踪的本地构建目录，不阻塞、提交或回滚", async () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "Build"));
    fs.writeFileSync(path.join(repo, "engine.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "Build", "tracked.bin"), "base build\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "Build", "tracked.bin"), "local build\n");
    fs.writeFileSync(path.join(repo, "Build", "untracked.pdb"), "local symbols\n");
    const workspace = new GitWorkspace(repo, ["Build/"]);
    const session = await workspace.prepareBranch("main", "yangfan", new Date(2026, 0, 2, 3, 4, 5));
    fs.writeFileSync(path.join(repo, "engine.txt"), "fixed\n");

    const result = await workspace.finalize(session, "fix engine bug");

    expect(result?.files).toEqual(["engine.txt"]);
    expect(fs.readFileSync(path.join(repo, "Build", "tracked.bin"), "utf-8")).toBe("local build\n");
    expect(fs.readFileSync(path.join(repo, "Build", "untracked.pdb"), "utf-8")).toBe("local symbols\n");
    expect(execFileSync("git", ["show", "--name-only", "--format=", result!.commit], { cwd: repo })
      .toString().trim()).toBe("engine.txt");
  });

  it("带忽略目录的失败回滚保留本地构建产物", async () => {
    const repo = tmpdir();
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    fs.mkdirSync(path.join(repo, "Build"));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "Build", "tracked.bin"), "base build\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });

    const workspace = new GitWorkspace(repo, ["Build/"]);
    const session = await workspace.prepareBranch("main", "yangfan", new Date(2026, 0, 2, 3, 4, 5));
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    fs.writeFileSync(path.join(repo, "temporary.txt"), "temporary\n");
    fs.writeFileSync(path.join(repo, "Build", "tracked.bin"), "local build\n");
    fs.writeFileSync(path.join(repo, "Build", "untracked.pdb"), "local symbols\n");

    await workspace.rollback(session);

    expect(fs.readFileSync(path.join(repo, "tracked.txt"), "utf-8").replace(/\r\n/g, "\n"))
      .toBe("base\n");
    expect(fs.existsSync(path.join(repo, "temporary.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "Build", "tracked.bin"), "utf-8")).toBe("local build\n");
    expect(fs.readFileSync(path.join(repo, "Build", "untracked.pdb"), "utf-8")).toBe("local symbols\n");
  });
});

describe("通用 MCP Agent 接入", () => {
  beforeEach(() => {
    mcpMockState.tools = [];
    mcpMockState.callResult = { content: [] };
    mcpMockState.calledTools = [];
    mcpMockState.closed = 0;
  });

  it("按仓库根解析所有启用服务，调查阶段生成只读 Codex MCP 配置", () => {
    const repo = tmpdir();
    const firstCwd = path.join(repo, "tools", "first");
    const secondCwd = path.join(repo, "tools", "second");
    fs.mkdirSync(firstCwd, { recursive: true });
    fs.mkdirSync(secondCwd, { recursive: true });
    const cfg = parseMcpServers({
      demo_mcp: {
        command: "python-test",
        args: ["{repo}\\tools\\first\\server.py"],
        cwd: "${repo}\\tools\\first",
        env: { PROJECT_ROOT: "{repo}" },
        read_only_tools: ["ping", "inspect"],
        disabled_tools: ["execute_python"],
      },
      second_mcp: {
        command: "node",
        args: ["server.js"],
        cwd: "{repo}\\tools\\second",
        enabled_tools: ["read", "write"],
        read_only_tools: ["read"],
      },
      agent_local_mcp: {
        command: "cmd",
        cwd: "{agent}",
        read_only_tools: [],
      },
      disabled_mcp: { enabled: false, command: "ignored" },
    });
    const servers = resolveMcpServers(cfg, repo, true);
    const codex = codexMcpConfig(servers) as Record<string, Record<string, Record<string, unknown>>>;

    expect(servers).toHaveLength(3);
    expect(servers[0].args).toEqual([path.join(firstCwd, "server.py")]);
    expect(servers[0].cwd).toBe(firstCwd);
    expect(servers[0].env.PROJECT_ROOT).toBe(repo);
    expect(servers[0].enabledTools).toEqual(["ping", "inspect"]);
    expect(servers[1].enabledTools).toEqual(["read"]);
    expect(servers[2].cwd).toBe(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    expect(codex.mcp_servers.demo_mcp.disabled_tools).toContain("execute_python");
    expect(codex.mcp_servers.demo_mcp.default_tools_approval_mode).toBe("approve");
    expect(codex.mcp_servers.demo_mcp.enabled_tools).toEqual(["ping", "inspect"]);
    expect(codex.mcp_servers.second_mcp.enabled_tools).toEqual(["read"]);
    expect(codex.mcp_servers.disabled_mcp).toBeUndefined();
  });

  it("实施阶段使用 enabled_tools，未配置 allowlist 时开放除 denylist 外的工具", () => {
    const repo = tmpdir();
    const cfg = parseMcpServers({
      allowlisted: { command: "node", cwd: "{repo}", enabled_tools: ["read", "write"] },
      unrestricted: { command: "node", cwd: "{repo}", disabled_tools: ["dangerous"] },
    });
    const servers = resolveMcpServers(cfg, repo, false);

    expect(servers[0].enabledTools).toEqual(["read", "write"]);
    expect(servers[1].enabledTools).toBeUndefined();
    expect(servers[1].disabledTools).toEqual(["dangerous"]);
  });

  it("远程 HTTP MCP 可直接映射到 Codex 配置", () => {
    const cfg = parseMcpServers({
      docs: {
        url: "https://mcp.example.com/mcp",
        bearer_token_env_var: "MCP_TOKEN",
        http_headers: { "X-Region": "cn" },
        env_http_headers: { "X-Tenant": "MCP_TENANT" },
        read_only_tools: ["search"],
      },
    });
    const codex = codexMcpConfig(resolveMcpServers(cfg, tmpdir(), true)) as Record<string, Record<string, Record<string, unknown>>>;

    expect(codex.mcp_servers.docs).toMatchObject({
      url: "https://mcp.example.com/mcp",
      bearer_token_env_var: "MCP_TOKEN",
      http_headers: { "X-Region": "cn" },
      env_http_headers: { "X-Tenant": "MCP_TENANT" },
      enabled_tools: ["search"],
    });
    expect(codex.mcp_servers.docs.command).toBeUndefined();
  });

  it("MCP 预检枚举实际工具、调用 ping，并生成禁止误用 resources API 的提示", async () => {
    const repo = tmpdir();
    mcpMockState.tools = [
      { name: "ping", inputSchema: { type: "object" } },
      { name: "read_blueprint_content", inputSchema: { type: "object" } },
      { name: "execute_python", inputSchema: { type: "object" } },
    ];
    mcpMockState.callResult = { content: [{ type: "text", text: "pong" }] };
    const [server] = resolveMcpServers(parseMcpServers({
      unreal_mcp: {
        command: "python",
        cwd: "{repo}",
        read_only_tools: ["ping", "read_blueprint_content", "missing_tool"],
        disabled_tools: ["execute_python"],
      },
    }), repo, true);

    const inspection = inspectMcpServer(server, await probeMcpServer(server));
    const guidance = mcpToolGuidance([inspection]);

    expect(inspection.availableTools).toEqual(["ping", "read_blueprint_content"]);
    expect(inspection.missingEnabledTools).toEqual(["missing_tool"]);
    expect(mcpMockState.calledTools).toEqual(["ping"]);
    expect(mcpMockState.closed).toBe(1);
    expect(guidance).toContain("服务 `unreal_mcp`");
    expect(guidance).toContain("`read_blueprint_content`");
    expect(guidance).toContain("禁止用 read_mcp_resource");
    expect(guidance).toContain("禁止把 tool 名当作 resource URI");
  });

  it("Chrome MCP 预检调用 list_pages，提前发现未开启远程调试", async () => {
    const repo = tmpdir();
    mcpMockState.tools = [
      { name: "list_pages", inputSchema: { type: "object" } },
      { name: "take_snapshot", inputSchema: { type: "object" } },
    ];
    mcpMockState.callResult = { content: [{ type: "text", text: "page 1" }] };
    const [server] = resolveMcpServers(parseMcpServers({
      chrome_devtools: {
        command: "npx",
        cwd: "{repo}",
        read_only_tools: ["list_pages", "take_snapshot"],
      },
    }), repo, true);

    const probe = await probeMcpServer(server);

    expect(probe.healthCheckTool).toBe("list_pages");
    expect(mcpMockState.calledTools).toEqual(["list_pages"]);
  });

  it("MCP 自己声明资源门禁关键词，禁用时转人工、启用时自动放行", () => {
    const disabled = parseMcpServers({
      prefab: { enabled: false, command: "node", automates_manual_keywords: ["prefab"] },
    });
    const policy = {
      min_score: 0,
      require_reproduction_signal: false,
      manual_keywords: configuredManualKeywords(disabled),
      high_risk_keywords: [],
    };
    const bug = makeBug({ title: "prefab 显示异常" });

    expect(assessFixability(bug, policy, []).disposition).toBe("manual_only");
    disabled.prefab.enabled = true;
    expect(assessFixability(bug, policy, ["prefab"]).disposition).toBe("auto_fix");
  });

  it("同时命中可自动和不可自动资源时仍保持人工门禁", () => {
    const bug = makeBug({ title: "prefab 引用的 xlsx 数据错误" });
    const result = assessFixability(bug, {
      min_score: 0,
      require_reproduction_signal: false,
      manual_keywords: ["prefab", "xlsx"],
      high_risk_keywords: [],
    }, ["prefab"]);

    expect(result.disposition).toBe("manual_only");
    expect(result.reasons.join(" ")).toContain("xlsx");
  });

  it("配置校验会拒绝不存在的绝对 command 和 cwd", () => {
    const cfg = makeConfig();
    const root = tmpdir();
    cfg.workspaces = [{
      workspace_id: "111", owner: "me", default_repo: "r",
      repos: [{ name: "r", path: root, verify_cmds: [] }],
    }];
    cfg.mcp_servers = parseMcpServers({
      broken: {
        command: path.join(root, "missing-python.exe"),
        cwd: "{repo}\\missing-cwd",
      },
    });

    const problems = validateConfig(cfg).join("\n");
    expect(problems).toContain("mcp_servers.broken.command 不存在");
    expect(problems).toContain("mcp_servers.broken.cwd 不存在");
  });
});

// ---------------------------------------------------------------------------
// settings overrides：web 设置页 → overrides.yaml
// ---------------------------------------------------------------------------
describe("settings overrides", () => {
  it("loadConfig 合并 overrides.yaml（字段级，未覆盖的保留）", () => {
    // 清掉真实环境里的 P4*/TAPD_* 变量，避免 env 覆盖干扰本次断言（结束后还原）
    const envKeys = ["P4PORT", "P4CLIENT", "P4USER", "P4PASSWD", "TAPD_ACCESS_TOKEN", "TAPD_API_USER", "TAPD_API_PASSWORD"];
    const saved = new Map(envKeys.map((k) => [k, process.env[k]]));
    for (const k of envKeys) delete process.env[k];
    try {
      const dir = tmpdir();
      const cfgPath = path.join(dir, "c.yaml");
      fs.writeFileSync(
        cfgPath,
        `pi:
  provider:
    id: kuro
    base_url: "https://base.example.com"
    model_id: "from-yaml"
p4:
  port: "yaml:1666"
  user: u
`,
        "utf-8",
      );
      const ovPath = path.join(dir, "ov.yaml");
      fs.writeFileSync(
        ovPath,
        `pi:
  provider:
    base_url: "https://override.example.com"
    model_id: "from-override"
p4:
  port: "override:1666"
`,
        "utf-8",
      );
      const cfg = loadConfig(cfgPath, "NO_SUCH_ENV_FILE.env", ovPath);
      expect(cfg.pi.provider?.base_url).toBe("https://override.example.com");
      expect(cfg.pi.provider?.model_id).toBe("from-override");
      expect(cfg.pi.provider?.id).toBe("kuro"); // 未覆盖字段保留
      expect(cfg.p4.port).toBe("override:1666");
      expect(cfg.p4.user).toBe("u"); // 未覆盖字段保留
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("applySettingsOverrides 直接改运行中 config（web POST 路径）", () => {
    const cfg = makeConfig();
    cfg.pi.provider = { id: "kuro", base_url: "https://old", model_id: "m1" };
    applySettingsOverrides(cfg, {
      pi: { provider: { model_id: "m2" } },
      p4: { client: "new-client" },
    });
    expect(cfg.pi.provider?.model_id).toBe("m2");
    expect(cfg.pi.provider?.base_url).toBe("https://old"); // 未提供字段保留
    expect(cfg.p4.client).toBe("new-client");
  });

  it("Agent/Codex/Reviewer 设置可在线覆盖", () => {
    const cfg = makeConfig();
    applySettingsOverrides(cfg, {
      agent: { backend: "codex" },
      codex: { model: "gpt-test", reasoning_effort: "xhigh", network_access: true },
      review: { backend: "pi" },
    });
    expect(cfg.agent.backend).toBe("codex");
    expect(cfg.codex.model).toBe("gpt-test");
    expect(cfg.codex.reasoning_effort).toBe("xhigh");
    expect(cfg.codex.network_access).toBe(true);
    expect(cfg.review.backend).toBe("pi");
  });

  it("saveSettingsOverrides 保留已有项，多次保存合并", () => {
    const dir = tmpdir();
    const p = path.join(dir, "ov.yaml");
    saveSettingsOverrides({ p4: { port: "a:1666" } }, p);
    saveSettingsOverrides({ pi: { provider: { model_id: "m" } } }, p);
    const ov = readSettingsOverrides(p);
    expect(ov?.p4?.port).toBe("a:1666");
    expect(ov?.pi?.provider?.model_id).toBe("m");
    // 写出的 YAML 可再被 loadConfig 读回
    const cfg = makeConfig();
    applySettingsOverrides(cfg, readSettingsOverrides(p));
    expect(cfg.p4.port).toBe("a:1666");
    expect(cfg.pi.provider?.model_id).toBe("m");
  });

  it("null/空值不覆盖（密钥留空保持原样）", () => {
    const cfg = makeConfig();
    cfg.p4.password = "secret";
    applySettingsOverrides(cfg, { p4: { password: "" }, tapd: { backend: "mcp" } });
    expect(cfg.p4.password).toBe("secret");
    expect(cfg.tapd.backend).toBe("mcp");
  });
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
describe("state", () => {
  it("store_crud", () => {
    const d = tmpdir();
    const store = new StateStore(path.join(d, "t.db"));
    try {
      expect(store.getControl()).toBe("stopped");
      store.setControl("running");
      expect(store.getControl()).toBe("running");

      const bug = makeBug();
      store.upsertJob(bug, { agent_state: "in_progress" });
      store.updateJob(bug.id, { agent_state: "review_pending", changelist: 42 });
      const job = store.getJob(bug.id);
      expect(job?.changelist).toBe(42);
      expect(job?.agent_state).toBe("review_pending");

      store.addEvent("test", "info", bug.id);
      const events = store.listEvents(bug.id);
      expect(events.length).toBe(1);
      expect(store.jobCount()).toBe(1);
      expect(store.jobStateCounts()["review_pending"]).toBe(1);
    } finally {
      store.close();
    }
  });

  it("files/manual_assets 为 null 时存真 NULL，不存字面 'null'（回归：web 详情 JSON.parse('null') 崩溃）", () => {
    const d = tmpdir();
    const store = new StateStore(path.join(d, "t.db"));
    try {
      const bug = makeBug();
      store.upsertJob(bug, { agent_state: "pending" });
      // retryBug 等路径传 null 表示「无内容」，必须落库为 NULL，不能变成字符串 "null"
      store.updateJob(bug.id, { files: null, manual_assets: null });
      const raw = (store as unknown as { db: Database.Database }).db
        .prepare("SELECT files, manual_assets, typeof(files) AS ft, typeof(manual_assets) AS mt FROM jobs WHERE bug_id=?")
        .get(bug.id) as { files: unknown; manual_assets: unknown; ft: string; mt: string };
      expect(raw.files).toBeNull();
      expect(raw.manual_assets).toBeNull();
      expect(raw.ft).toBe("null"); // SQLite typeof(NULL) === 'null'
      expect(raw.mt).toBe("null");
      // 数组仍存为 JSON 字符串，供前端 parse
      store.updateJob(bug.id, { files: ["//depot/a.cpp"], manual_assets: [{ path: "x", reason: "r" }] });
      const job = store.getJob(bug.id);
      expect(job?.files).toBe('["//depot/a.cpp"]');
      expect(JSON.parse(String(job?.manual_assets))[0].path).toBe("x");
      // 再清回 null 仍是 NULL
      store.updateJob(bug.id, { files: null });
      const raw2 = (store as unknown as { db: Database.Database }).db
        .prepare("SELECT files, typeof(files) AS ft FROM jobs WHERE bug_id=?")
        .get(bug.id) as { files: unknown; ft: string };
      expect(raw2.files).toBeNull();
      expect(raw2.ft).toBe("null");
    } finally {
      store.close();
    }
  });

  it("model 列存在且可读写", () => {
    const d = tmpdir();
    const store = new StateStore(path.join(d, "t.db"));
    try {
      const bug = makeBug();
      store.upsertJob(bug, { agent_state: "in_progress", agent: "pi", model: "claude-sonnet-5" });
      const job = store.getJob(bug.id);
      expect(job?.agent).toBe("pi");
      expect(job?.model).toBe("claude-sonnet-5");
    } finally {
      store.close();
    }
  });

  it("旧数据库 schema 直接报错，开发阶段不做自动迁移", () => {
    const d = tmpdir();
    const p = path.join(d, "old.db");
    const conn = new Database(p);
    conn.exec(`CREATE TABLE control (
                 id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, updated_at TEXT);
               CREATE TABLE jobs (
                 bug_id INTEGER PRIMARY KEY, workspace_id TEXT, title TEXT, priority TEXT,
                 priority_label TEXT, tapd_status TEXT, agent_state TEXT, changelist INTEGER,
                 generated_description TEXT, files TEXT, manual_assets TEXT, failure_reason TEXT,
                 agent TEXT, attempts INTEGER DEFAULT 0, started_at TEXT, finished_at TEXT);
               CREATE TABLE events (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, level TEXT, bug_id INTEGER, msg TEXT);
               CREATE INDEX idx_jobs_state ON jobs(agent_state);
               CREATE INDEX idx_events_bug ON events(bug_id);`);
    conn.close();
    expect(() => new StateStore(p)).toThrow(/数据库 schema 不匹配.*删除.*重建/);
  });

  it("记录人工接受、修改、拒绝和 reopen，并计算真实准确率指标", () => {
    const store = new StateStore(":memory:");
    const accepted = makeBug({ id: "1152729922001234001" });
    const modified = makeBug({ id: "1152729922001234002" });
    const rejected = makeBug({ id: "1152729922001234003" });
    store.upsertJob(accepted, { agent_state: "review_pending", changelist: 101 });
    store.upsertJob(modified, { agent_state: "review_pending", changelist: 102 });
    store.upsertJob(rejected, { agent_state: "review_pending", changelist: 103 });

    store.recordFeedback(accepted.id, {
      outcome: "accepted_unchanged",
      reason: "原样提交",
      human_changed_lines: 0,
      submitted_changelist: 101,
    });
    store.recordFeedback(modified.id, {
      outcome: "accepted_modified",
      reason: "补了一个边界判断",
      human_changed_lines: 4,
      submitted_changelist: 202,
    });
    store.recordFeedback(rejected.id, {
      outcome: "rejected_wrong_root_cause",
      reason: "根因判断错误",
      human_changed_lines: 0,
      submitted_changelist: null,
    });
    store.recordFeedback(accepted.id, {
      outcome: "reopened",
      reason: "线上再次复现",
      human_changed_lines: 0,
      submitted_changelist: 101,
    });

    expect(store.getJob(accepted.id)?.agent_state).toBe("reopened");
    expect(store.getJob(modified.id)?.agent_state).toBe("accepted_modified");
    expect(store.getJob(rejected.id)?.agent_state).toBe("rejected");
    const metrics = store.qualityMetrics();
    expect(metrics.reviewed).toBe(3);
    expect(metrics.accepted_unchanged).toBe(1);
    expect(metrics.accepted_modified).toBe(1);
    expect(metrics.rejected).toBe(1);
    expect(metrics.reopened).toBe(1);
    expect(metrics.candidate_precision).toBeCloseTo(2 / 3);
    expect(metrics.unchanged_acceptance_rate).toBeCloseTo(1 / 3);
  });

  it("拒绝未知反馈结果，避免污染评测标签", () => {
    const store = new StateStore(":memory:");
    const bug = makeBug();
    store.upsertJob(bug, { agent_state: "review_pending" });

    expect(() => store.recordFeedback(bug.id, {
      outcome: "looks_good" as never,
      reason: "",
      human_changed_lines: 0,
      submitted_changelist: null,
    })).toThrow("未知反馈结果");
  });
});

// ---------------------------------------------------------------------------
// p4 spec / 重试
// ---------------------------------------------------------------------------
describe("p4", () => {
  it("p4.ignore 映射为 P4IGNORE", () => {
    expect(p4EnvFromConfig({ ignore: ".p4ignore" })).toEqual({ P4IGNORE: ".p4ignore" });
  });

  it("P4 ignore_paths 可忽略已跟踪目录和任意层级生成目录", () => {
    const ignored = ["Config/", "Binaries/", "**/.github/agents/"];
    expect(p4PathIgnored("//nami/branch/Source/Client/Config/Build.ini", ignored)).toBe(true);
    expect(p4PathIgnored("//nami/branch/Source/Client/TypeScript/.github/agents/a.md", ignored)).toBe(true);
    expect(p4PathIgnored("//nami/branch/Source/Client/Source/Feature.cpp", ignored)).toBe(false);
  });

  it("由 ignore_paths 自动生成 P4IGNORE 文件，无需重复配置 p4.ignore", () => {
    const dir = tmpdir();
    expect(ensureP4IgnoreFile(dir, ["Saved/", "**/.github/agents/"])).toBe(GENERATED_P4IGNORE);
    expect(fs.readFileSync(path.join(dir, GENERATED_P4IGNORE), "utf-8")).toContain([
      GENERATED_P4IGNORE,
      "Saved/",
      "**/.github/agents/",
    ].join("\n"));
  });

  it("set_description", () => {
    const spec = "Change:\tnew\n\nClient:\ttapd-agent_x\n\nDescription:\n\t<enter description here>\n\nFiles:\n\t//depot/a.cpp#1 edit\n";
    const out = setSpecField(spec, "Description", "第一行\n第二行");
    expect(out).toContain("Description:\n\t第一行\n\t第二行");
    expect(out).toContain("//depot/a.cpp#1 edit"); // Files 段保留
    for (const line of out.split("\n")) {
      if (line.includes("第一行") || line.includes("第二行")) {
        expect(line.startsWith("\t")).toBe(true); // p4 spec 字段值须 Tab 缩进
      }
    }
  });

  it("opened() 解析真实 p4 输出（#rev 与路径间无空格）", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    (client as unknown as { run: () => Promise<string> }).run = async () => [
      "//nami/branch_0.7.0/a.ts#6 - edit default change (text)",
      "//nami/branch_0.7.0/b.ts#9 - edit change 1234 (unicode)",
      "//nami/branch_0.7.0/c.ts#1 - add default change (text)",
    ].join("\n");
    const o = await client.opened();
    expect(o).toHaveLength(3);
    expect(o[0]).toEqual({ depot: "//nami/branch_0.7.0/a.ts", action: "edit", changelist: "default", type: "text" });
    expect(o[1]).toEqual({ depot: "//nami/branch_0.7.0/b.ts", action: "edit", changelist: "1234", type: "unicode" });
    expect(o[2]).toEqual({ depot: "//nami/branch_0.7.0/c.ts", action: "add", changelist: "default", type: "text" });
  });

  it("opened() 排除 P4 ignore_paths 中已受控的文件", async () => {
    const client = new P4Client("C:\\tmp", {}, undefined, undefined, ["Config/"]);
    (client as unknown as { run: () => Promise<string> }).run = async () => [
      "//nami/branch/Source/Client/Config/Build.ini#1 - edit default change (text)",
      "//nami/branch/Source/Client/Source/Fix.cpp#2 - edit default change (text)",
    ].join("\n");
    expect(await client.opened("default")).toEqual([{
      depot: "//nami/branch/Source/Client/Source/Fix.cpp",
      action: "edit",
      changelist: "default",
      type: "text",
    }]);
  });

  it("回归：opened('default') 必须带 -c default（不带会把编号 changelist 的文件混进新 pending，p4 change -i 报 Can't include file(s) not already opened）", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: string[][] = [];
    (client as unknown as { run: (a: string[]) => Promise<string> }).run = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    await client.opened("default");
    await client.opened();
    expect(calls[0]).toEqual(["opened", "-c", "default"]);
    expect(calls[1]).toEqual(["opened"]);
  });

  it("opened 严格模式遇到连接异常时抛错，避免误报 P4 连接成功", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      throw new P4Error("Connect to server failed");
    };
    await expect(client.opened("default", true)).rejects.toThrow("Connect to server failed");
  });

  it("识别休眠、VPN 和服务器拒绝造成的 P4 连接故障", () => {
    expect(isP4ConnectionFailure("Connect to server failed; WSAECONNREFUSED")).toBe(true);
    expect(isP4ConnectionFailure("TCP connect failed: network is unreachable")).toBe(true);
    expect(isP4ConnectionFailure("no such file(s)")).toBe(false);
  });

  it("opened 遇到短暂 P4 断线时自动重连后继续", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    let calls = 0;
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      calls += 1;
      if (calls < 3) throw new P4ConnectionError("Connect to server failed; WSAECONNREFUSED");
      return "//depot/Fix.ts#1 - edit default change (text)";
    };
    client.sleep = async () => {};

    expect(await client.opened("default", true)).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("diff 连接失败时单次降级，不重试也不中断已完成修复", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    let calls = 0;
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      calls += 1;
      throw new P4ConnectionError("Connect to server failed; WSAECONNREFUSED");
    };

    await expect(client.diffUnified(["//depot/Fix.ts"])).resolves.toBe("");
    expect(calls).toBe(1);
  });

  it("reconcile -n 默认扫描当前仓库目录并使用 2 分钟超时", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    (client as unknown as {
      run: (args: string[], input?: string, timeout?: number) => Promise<string>;
    }).run = async (args: string[], _input?: string, timeout?: number) => {
      calls.push({ args, timeout });
      return "";
    };
    await client.reconcilePreview();
    expect(calls).toEqual([{ args: ["reconcile", "-n", "./..."], timeout: 2 * 60 * 1000 }]);
  });

  it("reconcile -n 可只扫描 planned_files", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: string[][] = [];
    (client as unknown as { run: (args: string[]) => Promise<string> }).run = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    await client.reconcilePreview(["./Source/Foo.cpp", "./Content/A.uasset"]);
    expect(calls).toEqual([[
      "reconcile", "-n", "./Source/Foo.cpp", "./Content/A.uasset",
    ]]);
  });

  it("reconcile 过滤忽略路径，并只打开预览中允许的文件", async () => {
    const client = new P4Client("C:\\tmp", {}, undefined, undefined, ["Config/", "**/.github/agents/"]);
    const calls: string[][] = [];
    (client as unknown as { run: (args: string[]) => Promise<string> }).run = async (args: string[]) => {
      calls.push(args);
      return [
        "//nami/branch/Source/Client/Config/Build.ini#1 - opened for edit",
        "... //nami/branch/Source/Client/Config/Build.ini - also opened by other@client",
        "//nami/branch/Source/Client/TypeScript/.github/agents/a.md#1 - opened for add",
        "//nami/branch/Source/Client/Source/Fix.cpp#2 - opened for edit",
      ].join("\n");
    };
    const preview = await client.reconcilePreview();
    expect(preview).toContain("Source/Fix.cpp");
    expect(preview).not.toContain("Config/Build.ini");
    expect(preview).not.toContain("also opened by");
    expect(preview).not.toContain(".github/agents/a.md");
    await client.reconcile(preview);
    expect(calls[1]).toEqual(["reconcile", "//nami/branch/Source/Client/Source/Fix.cpp"]);
  });

  it("reconcile -n 被人工取消时向上抛出，不降级成无本地改动", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      throw new P4CancelledError("人工取消");
    };

    await expect(client.reconcilePreview()).rejects.toBeInstanceOf(P4CancelledError);
  });

  it("回归：revert 默认带 -c default（绝不误撤编号 changelist 里其它 bug 的改动）", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: string[][] = [];
    (client as unknown as { run: (a: string[]) => Promise<string> }).run = async (args: string[]) => {
      calls.push(args);
      return "";
    };
    await client.revert(["//depot/a.ts"]);
    expect(calls[0]).toEqual(["revert", "-c", "default", "//depot/a.ts"]);
    expect(await client.revert([])).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("sync 瞬时错误重试后成功", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls = { n: 0 };
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      calls.n += 1;
      if (calls.n < 3) throw new P4Error("rename: failed to rename ... 文件被占用");
      return "updated";
    };
    const out = await client.sync(["./..."], 600000, 3, 0);
    expect(out).toBe("updated");
    expect(calls.n).toBe(3);
  });

  it("sync 默认同步当前仓库目录并使用 10 分钟超时", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: Array<{ args: string[]; timeout?: number }> = [];
    (client as unknown as {
      run: (args: string[], input?: string, timeout?: number) => Promise<string>;
    }).run = async (args: string[], _input?: string, timeout?: number) => {
      calls.push({ args, timeout });
      return "updated";
    };
    await client.sync();
    expect(calls).toEqual([{
      args: ["sync", "--parallel=threads=4,min=10", "./..."],
      timeout: 10 * 60 * 1000,
    }]);
  });

  it("sync 可只同步 planned_files 目标", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    const calls: string[][] = [];
    (client as unknown as { run: (args: string[]) => Promise<string> }).run = async (args) => {
      calls.push(args);
      return "updated";
    };
    await client.sync(["./Source/Foo.cpp", "./Content/A.uasset"]);
    expect(calls).toEqual([[
      "sync", "--parallel=threads=4,min=10", "./Source/Foo.cpp", "./Content/A.uasset",
    ]]);
  });

  it("sync 超时立即失败，不继续重试", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    let calls = 0;
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      calls += 1;
      throw new P4Error("p4 sync ./... 超时(600s)");
    };
    await expect(client.sync(["./..."], 600000, 3, 0)).rejects.toThrow("超时(600s)");
    expect(calls).toBe(1);
  });

  it("sync 普通确定性错误不重试", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    let calls = 0;
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      calls += 1;
      throw new P4Error("p4 sync ./... 失败: no such file(s)");
    };
    await expect(client.sync(["./..."], 600000, 3, 0)).rejects.toThrow("no such file");
    expect(calls).toBe(1);
  });

  it("sync 持续失败抛最后一次错误", async () => {
    const client = new P4Client("C:\\tmp", { client: "test-client" });
    let lastErr: unknown = null;
    (client as unknown as { run: () => Promise<string> }).run = async () => {
      lastErr = new P4Error("rename: failed to rename ... 文件被占用");
      throw lastErr;
    };
    await expect(client.sync(["./..."], 600000, 2, 0)).rejects.toBeInstanceOf(P4Error);
    expect(lastErr).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verify: reconcile 兜底
// ---------------------------------------------------------------------------
class FakeP4 {
  private _opened: OpenedFile[];
  preview: string;
  reconciled = false;
  constructor(opened: OpenedFile[], preview: string) {
    this._opened = opened;
    this.preview = preview;
  }
  async opened(cl?: string): Promise<OpenedFile[]> {
    // 模拟真实 p4 opened -c <cl>：按 changelist 过滤；不传返回全部
    return [...this._opened].filter((o) => !cl || o.changelist === cl);
  }
  async reconcilePreview(): Promise<string> {
    return this.preview;
  }
  async reconcile(): Promise<string> {
    this.reconciled = true;
    if (this.preview.trim() && !this._opened.length) {
      this._opened = [
        { depot: "//nami/.../x.cpp", action: "edit", changelist: "default", type: "text" },
      ];
    }
    return "";
  }
}

describe("checkAndPrepareP4", () => {
  it("只把 project planned_files 转成精确 P4 reconcile 目标", () => {
    expect(p4ReconcileTargets([
      "project:Source/Foo.cpp",
      "project:Content/A.uasset",
      "engine:Engine/Source/Bar.cpp",
      "project:../outside.txt",
      "project:Source/Foo.cpp",
    ])).toEqual(["./Source/Foo.cpp", "./Content/A.uasset"]);
  });

  it("Agent 漏了 p4 edit 时 reconcile 兜底", async () => {
    const fake = new FakeP4([], "...//x.cpp#1 - edit from D:/...");
    const opened = await checkAndPrepareP4(fake as unknown as P4Client, ["./x.cpp"]);
    expect(fake.reconciled).toBe(true);
    expect(opened.length).toBe(1);
  });

  it("完全无改动抛 VerificationError", async () => {
    const fake = new FakeP4([], "");
    await expect(checkAndPrepareP4(fake as unknown as P4Client)).rejects.toBeInstanceOf(VerificationError);
    expect(fake.reconciled).toBe(false);
  });

  it("已有 opened 且无差异时跳过 reconcile", async () => {
    const fake = new FakeP4(
      [{ depot: "//nami/.../x.cpp", action: "edit", changelist: "default", type: "text" }],
      "",
    );
    const opened = await checkAndPrepareP4(fake as unknown as P4Client);
    expect(fake.reconciled).toBe(false);
    expect(opened.length).toBe(1);
  });

  it("回归：只收集 default changelist 的文件，绝不混入编号 changelist（其它 bug 的 pending CL）", async () => {
    const fake = new FakeP4(
      [
        { depot: "//nami/.../mine.ts", action: "edit", changelist: "default", type: "text" },
        { depot: "//nami/.../other1.ts", action: "edit", changelist: "737633", type: "text" },
        { depot: "//nami/.../other2.ts", action: "edit", changelist: "737633", type: "text" },
      ],
      "",
    );
    const opened = await checkAndPrepareP4(fake as unknown as P4Client);
    expect(opened.map((o) => o.depot)).toEqual(["//nami/.../mine.ts"]);
  });

  it("回归：default 无改动但编号 changelist 有文件时，报错信息点明编号 changelist", async () => {
    const fake = new FakeP4(
      [{ depot: "//nami/.../other.ts", action: "edit", changelist: "737633", type: "text" }],
      "",
    );
    await expect(checkAndPrepareP4(fake as unknown as P4Client)).rejects.toThrow(/737633/);
  });
});

// ---------------------------------------------------------------------------
// agent 解析
// ---------------------------------------------------------------------------
describe("agent parsing", () => {
  it("extract_final_json_marker", () => {
    const text = 'xx\nFINAL_RESULT:\n```json\n{"summary": "ok", "changed_files": ["a.cpp"], "manual_assets": [{"path":"p","reason":"r"}]}\n```';
    const data = extractFinalJson(text);
    expect(data?.summary).toBe("ok");
    expect(data?.changed_files).toEqual(["a.cpp"]);
  });

  it("回归：FINAL_RESULT 后的 JSON 拖着网关泄漏的 DSML 协议标签仍可解析（bug 1256834 实例）", () => {
    const text =
      'Now I have a good picture. Implement the fix...\n' +
      'FINAL_RESULT: {"summary": "修复了 AOI 外坐标解析，tsc 0 错误。", "changed_files": ["TypeScript/Src/Game/Module/Map/MapUtil.ts"], "manual_assets": [], "blocked_reasons": []}</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';
    const data = extractFinalJson(text);
    expect(data?.summary).toContain("AOI");
    expect(data?.changed_files).toEqual(["TypeScript/Src/Game/Module/Map/MapUtil.ts"]);
  });

  it("回归：JSON 被网关整体转义（\\\"key\\\":）时反转义后解析", () => {
    const text =
      'FINAL_RESULT: {\\"summary\\": \\"修复\\", \\"changed_files\\": [\\"a.ts\\"], \\"manual_assets\\": [], \\"blocked_reasons\\": []}尾部残渣';
    const data = extractFinalJson(text);
    expect(data?.summary).toBe("修复");
    expect(data?.changed_files).toEqual(["a.ts"]);
  });

  it("回归：没有 FINAL_RESULT 标记时，从输出尾部兜底提取结果形状的 JSON", () => {
    const text = '分析……（网关吞掉了标记）\n{"summary": "s", "changed_files": ["x.ts"], "manual_assets": [], "blocked_reasons": []}';
    const data = extractFinalJson(text);
    expect(data?.changed_files).toEqual(["x.ts"]);
  });

  it("结构化输出为纯调查 JSON 时也可提取", () => {
    const text = JSON.stringify({
      root_cause: "缓存失效后仍解引用旧对象",
      evidence: ["[观察] project:Login.ts:42", "[推断] 旧对象为空导致崩溃"],
      reproduction: { command: "npm test -- login", before: "FAIL" },
      diagnostic_pages: [],
      planned_files: ["project:Login.ts"],
      confidence: 0.9,
      blocked_reasons: [],
    });
    const data = extractFinalJson(text);
    expect(data?.root_cause).toContain("缓存失效");
    expect(data?.planned_files).toEqual(["project:Login.ts"]);
  });

  it("回归：围栏开栏行后直接跟 JSON（stripCodeFence 曾把正文清成空串）", () => {
    const text = 'FINAL_RESULT:\n```json\n{"summary": "围栏", "changed_files": ["b.ts"]}\n```';
    const data = extractFinalJson(text);
    expect(data?.summary).toBe("围栏");
    expect(data?.changed_files).toEqual(["b.ts"]);
  });

  it("JSON 字符串值里的花括号不影响配平扫描", () => {
    const text = 'FINAL_RESULT: {"summary": "改了 if (a) { b } 的判断", "changed_files": ["c.ts"], "manual_assets": [], "blocked_reasons": []}';
    const data = extractFinalJson(text);
    expect(data?.summary).toBe("改了 if (a) { b } 的判断");
  });

  it("result_from_output 解析结构化结果", () => {
    const ar = resultFromOutput('FINAL_RESULT: {"summary": "修复", "manual_assets": [{"path":"a.prefab"}]}', 0);
    expect(ar.ok).toBe(true);
    expect(ar.summary).toBe("修复");
    expect(ar.manual_assets.length).toBe(1);
  });

  it("长输出保留末尾 FINAL_RESULT，供调查和 Reviewer 二次解析", () => {
    const final = 'FINAL_RESULT: {"summary":"完成","changed_files":["a.ts"],"blocked_reasons":[]}';
    const ar = resultFromOutput("分析".repeat(20000) + final, 0);

    expect(ar.raw_output).toContain(final);
    expect(ar.raw_output.length).toBeLessThanOrEqual(32000);
  });

  it("即使输出了结构化 JSON，非零退出码仍保持失败", () => {
    const ar = resultFromOutput(
      'FINAL_RESULT: {"summary":"部分完成","changed_files":["a.ts"],"blocked_reasons":[]}',
      2,
    );

    expect(ar.ok).toBe(false);
    expect(ar.changed_files).toEqual(["a.ts"]);
  });

  it("无 JSON 时回落为文本摘要", () => {
    const ar = resultFromOutput("some random text", 0);
    expect(ar.ok).toBe(true);
    expect(ar.summary).toBeTruthy();
  });

  it("extract_final_text 从 agent_end 拼接最终文本", () => {
    const lines = [
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "修复完成" }] }],
      }),
    ];
    expect(extractFinalText(lines)).toBe("修复完成");
  });

  it("progress_from_tool_execution_start", () => {
    const line = JSON.stringify({ type: "tool_execution_start", toolName: "Grep", args: { pattern: "foo" } });
    const msg = progressFromLine(line);
    expect(msg).toBeTruthy();
    expect(msg).toContain("Grep");
    expect(msg).toContain("foo");
  });

  it("progress_from_message_update（pi 真实形状）", () => {
    // pi 的 message_update 事件：文本增量在 assistantMessageEvent.delta，累计全文在 message.content
    const line = JSON.stringify({
      type: "message_update",
      message: { content: [{ type: "text", text: "分析中" }] },
      assistantMessageEvent: { type: "text_delta", delta: "分析中", partial: {} },
    });
    expect(progressFromLine(line)).toBe("Agent: 分析中");
  });

  it("progress 忽略 thinking 增量与无关行", () => {
    expect(progressFromLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "…思考…" },
    }))).toBeUndefined();
    expect(progressFromLine("not json")).toBeUndefined();
    expect(progressFromLine(JSON.stringify({ type: "session" }))).toBeUndefined();
    expect(progressFromLine(JSON.stringify({ type: "result" }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PiAgent 子进程：超时 / 取消 / 流式（仅验证本地 fake pi 行为，不调真实 pi）
// ---------------------------------------------------------------------------
function writeFakePi(dir: string, body: string): void {
  if (process.platform === "win32") {
    // cmd shim：与真实 npm 全局安装的 pi.cmd 相同机制（shell:true 经 cmd 执行）
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

describe("PiAgent 子进程控制", () => {
  it("只读调查统一挂载所有 Pi MCP 并限制为各自只读工具", async () => {
    const d = tmpdir();
    writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    const cfg = makeConfig();
    cfg.mcp_servers = parseMcpServers({
      unreal_mcp: {
        command: "python",
        cwd: "{repo}",
        read_only_tools: ["ping", "inspect"],
        disabled_tools: ["execute_python"],
      },
      prefab_mcp2: {
        command: "python",
        cwd: "{repo}",
        read_only_tools: ["lgui_ping"],
      },
    });
    const agent = new PiAgent(cfg);
    await withFakePiOnPath(d, async () => {
      await agent.run({
        prompt: "x",
        repoDir: d,
        timeoutS: 60,
        tools: ["read", "grep"],
        sandboxMode: "read-only",
      });
    });

    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain("--extension");
    expect(args).toContain("unreal_mcp_ping");
    expect(args).toContain("prefab_mcp2_lgui_ping");
    expect(args).not.toContain("unreal_mcp_execute_python");
  });

  it("只读阶段通过 --tools 限制为代码浏览工具，并可覆盖评审模型", async () => {
    const d = tmpdir();
    writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      await agent.run({
        prompt: "x",
        repoDir: d,
        timeoutS: 60,
        tools: ["read", "grep", "find", "ls"],
        model: "kuro/reviewer-model",
      });
    });

    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain("--tools");
    expect(args).toContain("read,grep,find,ls");
    expect(args).toContain("--model");
    expect(args).toContain("kuro/reviewer-model");
  });

  it("超时杀进程树并抛 AgentRuntimeError", async () => {
    const d = tmpdir();
    writeFakePi(d, 'node -e "setTimeout(()=>{},120000)"');
    const agent = new PiAgent(makeConfig());
    const t0 = Date.now();
    await withFakePiOnPath(d, async () => {
      await expect(agent.run({ prompt: "x", repoDir: d, timeoutS: 2 })).rejects.toBeInstanceOf(AgentRuntimeError);
    });
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  it("人工取消抛 AgentCancelledError", async () => {
    const d = tmpdir();
    writeFakePi(d, 'node -e "setTimeout(()=>{},120000)"');
    const agent = new PiAgent(makeConfig());
    const evt = new CancelEvent();
    setTimeout(() => evt.set(), 300);
    const t0 = Date.now();
    await withFakePiOnPath(d, async () => {
      await expect(
        agent.run({ prompt: "x", repoDir: d, timeoutS: 60, cancelEvent: evt }),
      ).rejects.toBeInstanceOf(AgentCancelledError);
    });
    expect(Date.now() - t0).toBeLessThan(20000);
  });

  it("未取消时正常完成", async () => {
    const d = tmpdir();
    writeFakePi(d, "node -e \"console.log('done')\"");
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      const ar = await agent.run({ prompt: "x", repoDir: d, timeoutS: 60 });
      expect(ar.ok).toBe(true);
      expect(ar.summary).toContain("done");
    });
  });

  it("spawn 参数必须含 --print（非交互模式；缺失会让 pi 进交互挂起、零输出、跑满超时）", async () => {
    const d = tmpdir();
    if (process.platform === "win32") {
      // 用 & 串两段：把收到的参数写到 args.txt，再正常输出一行
      writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    } else {
      writeFakePi(d, "echo \"$@\" > args.txt; node -e \"console.log('done')\"");
    }
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      const ar = await agent.run({ prompt: "x", repoDir: d, timeoutS: 60 });
      expect(ar.ok).toBe(true);
    });
    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain("--print");
    expect(args).toContain("--mode");
  });

  it("团队共享 skill 目录：仓库下存在 .agents/skills / .agent/skills 时逐个 --skill 挂载", async () => {
    const d = tmpdir();
    // 模拟团队仓库：两种拼法各建一个 skills 目录
    fs.mkdirSync(path.join(d, ".agents", "skills", "team-skill"), { recursive: true });
    fs.mkdirSync(path.join(d, ".agent", "skills"), { recursive: true });
    writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      await agent.run({ prompt: "x", repoDir: d, timeoutS: 60 });
    });
    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain("--skill");
    expect(args).toContain(path.join(d, ".agents", "skills"));
    expect(args).toContain(path.join(d, ".agent", "skills"));
  });

  it("仓库下没有 .agent(s) 目录时不传 --skill（保持现状，不报错）", async () => {
    const d = tmpdir();
    writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      await agent.run({ prompt: "x", repoDir: d, timeoutS: 60 });
    });
    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).not.toContain("--skill");
  });

  it("pi.skill_dirs 配置覆盖默认目录（含绝对路径；存在的默认目录也被排除）", async () => {
    const d = tmpdir();
    const custom = tmpdir();
    fs.mkdirSync(custom, { recursive: true });
    // 两个默认拼法目录都建出来；配置只留 .agents/skills → .agent/skills 即使存在也不得被挂载
    fs.mkdirSync(path.join(d, ".agents", "skills"), { recursive: true });
    fs.mkdirSync(path.join(d, ".agent", "skills"), { recursive: true });
    const cfg = makeConfig();
    cfg.pi.skill_dirs = [custom, ".agents/skills"];
    writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    const agent = new PiAgent(cfg);
    await withFakePiOnPath(d, async () => {
      await agent.run({ prompt: "x", repoDir: d, timeoutS: 60 });
    });
    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain(custom); // 绝对路径原样
    expect(args).toContain(path.join(d, ".agents", "skills")); // 相对按仓库根解析
    expect(args).not.toContain(path.join(d, ".agent", "skills")); // 未列入配置 → 被覆盖排除
  });

  it("多行 prompt 不被 cmd 拆成碎片（Windows 用 @file 传引用，回归：shell:true 会把含换行的 argv 按换行拆分，pi 只收到第一行碎片、丢失全部 Bug 信息）", async () => {
    const d = tmpdir();
    if (process.platform === "win32") {
      // 用 & 串两段：把收到的参数写到 args.txt，再正常输出一行
      writeFakePi(d, "echo %* > args.txt & node -e \"console.log('done')\"");
    } else {
      writeFakePi(d, "echo \"$@\" > args.txt; node -e \"console.log('done')\"");
    }
    const agent = new PiAgent(makeConfig());
    const prompt =
      "你是自动修复 Tapd Bug 的编码 Agent。请修复下面的 Bug。\n\n# Bug 信息\n标题: 测试标题\n描述: 测试描述内容\n";
    await withFakePiOnPath(d, async () => {
      const ar = await agent.run({ prompt, repoDir: d, timeoutS: 60 });
      expect(ar.ok).toBe(true);
    });
    const args = fs.readFileSync(path.join(d, "args.txt"), "utf-8");
    expect(args).toContain("--print");
    expect(args).toContain("--mode");
    if (process.platform === "win32") {
      // Windows：prompt 必须经 @临时文件引用传递，argv 里不能出现被 cmd 拆开的碎片
      expect(args).not.toContain("请修复下面的");
      expect(args).not.toContain("Bug 信息");
      expect(args).toMatch(/@[A-Za-z]:[\\/][^\s]*prompt\.md/);
    } else {
      // POSIX：直接传参，argv 里应包含完整多行 prompt
      expect(args).toContain("# Bug 信息");
      expect(args).toContain("请修复下面的");
    }
  });

  it("spawn 必须 stdio ignore stdin（否则 pi 的 readPipedStdin 永久等 stdin 'end' 挂死、零输出、跑满超时）", async () => {
    const d = tmpdir();
    // fake pi 读 stdin：stdin 是 ignore/EOF → 立即 'end' 输出 stdin-eof；
    // stdin 是没关闭的 pipe → 读不到 end，1.5s 后输出 stdin-still-open。
    const body =
      "node -e \"process.stdin.resume();process.stdin.on('end',()=>{console.log('stdin-eof');process.exit(0)});setTimeout(()=>{console.log('stdin-still-open');process.exit(0)},1500)\"";
    writeFakePi(d, body);
    const agent = new PiAgent(makeConfig());
    await withFakePiOnPath(d, async () => {
      const ar = await agent.run({ prompt: "x", repoDir: d, timeoutS: 10 });
      expect(ar.ok).toBe(true);
      expect(ar.summary).toContain("stdin-eof");
      expect(ar.summary).not.toContain("stdin-still-open");
    });
  });

  it("逐行回调 onProgress：文本增量合并上报，工具事件逐条透传", async () => {
    const d = tmpdir();
    // 3 个无换行的短文本增量 + 1 个工具事件：增量应合并（不再逐 token 刷事件表），
    // 工具事件保持逐条且先冲刷缓冲的文本。事件数据写文件读取，避免 cmd shim 双引号转义问题。
    const lines = [
      { type: "message_update", message: { content: [{ type: "text", text: "line 0" }] }, assistantMessageEvent: { type: "text_delta", delta: "line 0" } },
      { type: "message_update", message: { content: [{ type: "text", text: "line 1" }] }, assistantMessageEvent: { type: "text_delta", delta: "line 1" } },
      { type: "tool_execution_start", toolName: "Bash", args: { command: "p4 edit a.ts" } },
      { type: "message_update", message: { content: [{ type: "text", text: "line 2" }] }, assistantMessageEvent: { type: "text_delta", delta: "line 2" } },
    ];
    fs.writeFileSync(path.join(d, "lines.json"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFakePi(d, "node -e \"require('fs').readFileSync('lines.json','utf8').trim().split(/\\n/).forEach(l=>console.log(l))\"");
    const agent = new PiAgent(makeConfig());
    const progress: string[] = [];
    await withFakePiOnPath(d, async () => {
      const ar = await agent.run({
        prompt: "x",
        repoDir: d,
        timeoutS: 60,
        onProgress: (m) => progress.push(m),
      });
      expect(ar.ok).toBe(true);
    });
    // 前 2 个增量合并成一条；工具事件单独一条；末尾增量收尾时冲刷
    expect(progress).toEqual([
      "Pi: 准备调用模型 (Pi 默认模型)（sandbox=workspace-write，timeout=60s）",
      "Agent: line 0line 1",
      "Agent: Bash p4 edit a.ts",
      "Agent: line 2",
      "Pi: 进程结束（exit=0）",
    ]);
  });

  it("含换行的文本增量立即冲刷（不积压整段输出）", async () => {
    const d = tmpdir();
    const lines = [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "第一行\n" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "第二行\n" } },
    ];
    fs.writeFileSync(path.join(d, "lines.json"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFakePi(d, "node -e \"require('fs').readFileSync('lines.json','utf8').trim().split(/\\n/).forEach(l=>console.log(l))\"");
    const agent = new PiAgent(makeConfig());
    const progress: string[] = [];
    await withFakePiOnPath(d, async () => {
      await agent.run({ prompt: "x", repoDir: d, timeoutS: 60, onProgress: (m) => progress.push(m) });
    });
    expect(progress).toEqual([
      "Pi: 准备调用模型 (Pi 默认模型)（sandbox=workspace-write，timeout=60s）",
      "Agent: 第一行",
      "Agent: 第二行",
      "Pi: 进程结束（exit=0）",
    ]);
  });
});

// ---------------------------------------------------------------------------
// worker web 合并
// ---------------------------------------------------------------------------
describe("worker web 合并", () => {
  it("列表包含未处理 bug", async () => {
    const w = makeWorker();
    stubMyBugs(w, [makeBug({ id: "1152729922001254287" })]);
    const rows = await w.listBugsForWeb();
    expect(rows.length).toBe(1);
    expect(rows[0].agent_state).toBeUndefined();
    expect(rows[0].has_local).toBe(false);
  });

  it("列表合并本地处理状态", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "failed" });
    const rows = await w.listBugsForWeb();
    expect(rows[0].agent_state).toBe("failed");
    expect(rows[0].has_local).toBe(true);
  });

  it("列表排除 rejected 状态", async () => {
    const w = makeWorker();
    stubMyBugs(w, [
      makeBug({ id: "1", status: "new" }),
      makeBug({ id: "2", status: "rejected" }),
    ]);
    const rows = await w.listBugsForWeb();
    expect(rows.length).toBe(1);
    expect(rows[0].bug_id).toBe("1");
  });

  it("bug_id 以字符串传输（大整数防丢精度）", async () => {
    const w = makeWorker();
    const big = "1152729922001234007";
    const bug = makeBug({ id: big });
    stubMyBugs(w, [bug]);
    const rows = await w.listBugsForWeb();
    expect(rows[0].bug_id).toBe(big);

    const d1 = await w.bugDetailForWeb(big);
    expect(d1?.bug_id).toBe(big);

    w.store.upsertJob(bug, { agent_state: "in_progress" });
    const d2 = await w.bugDetailForWeb(big);
    expect(d2?.bug_id).toBe(big); // job 字段覆盖后仍为字符串
  });

  it("未处理详情字段齐全", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287", description: "锻造引导后轮盘不显示" });
    stubMyBugs(w, [bug]);
    const d = await w.bugDetailForWeb(bug.id);
    expect(d?.description).toBe("锻造引导后轮盘不显示");
    expect(d?.agent_state).toBeUndefined();
    expect(d?.files).toBe("[]");
    expect(d?.events).toEqual([]);
    expect(d?.progress).toEqual([]);
  });

  it("详情可 JSON 序列化：事件行 id / 数值列不带 BigInt（回归：web 详情 500）", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "in_progress", attempts: 2, changelist: 12345 });
    w.store.addEvent("Agent 开始", "debug", bug.id);
    w.store.addEvent("已生成 changelist", "info", bug.id);

    // 事件行原始 id 是 BigInt（safeIntegers 打开），正是之前崩 JSON.stringify 的来源
    const rawEvents = w.store.listEvents(bug.id, 10);
    expect(typeof rawEvents[0].id).toBe("bigint");

    const d = await w.bugDetailForWeb(bug.id);
    expect(d?.attempts).toBe(2);
    expect(d?.changelist).toBe(12345);
    expect(typeof d?.events[0]?.id).toBe("number");
    expect(typeof d?.progress[0]?.id).toBe("number");
    expect(() => JSON.stringify(d)).not.toThrow();
  });

  it("列表与详情展示 agent/model", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "in_progress" });
    w.store.updateJob(bug.id, { agent: "pi", model: "claude-sonnet-5" });
    const rows = await w.listBugsForWeb();
    expect(rows[0].agent).toBe("pi");
    expect(rows[0].model).toBe("claude-sonnet-5");
    const d = await w.bugDetailForWeb(bug.id);
    expect(d?.agent).toBe("pi");
    expect(d?.model).toBe("claude-sonnet-5");
  });

  it("未处理 bug 无 agent/model", async () => {
    const w = makeWorker();
    stubMyBugs(w, [makeBug({ id: "1152729922001254287" })]);
    const rows = await w.listBugsForWeb();
    expect(rows[0].agent).toBeUndefined();
    expect(rows[0].model).toBeUndefined();
  });

  it("详情合并 job 事件", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "in_progress" });
    w.store.addEvent("开始处理", "info", bug.id);
    const d = await w.bugDetailForWeb(bug.id);
    expect(d?.agent_state).toBe("in_progress");
    expect((d?.events as unknown[]).length).toBe(1);
    expect(d?.has_local).toBe(true);
  });

  it("debug 级事件进 progress，系统事件留 events", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "in_progress" });
    w.store.addEvent("Agent: Grep pattern", "debug", bug.id);
    w.store.addEvent("p4 sync 完成", "info", bug.id);
    const d = await w.bugDetailForWeb(bug.id);
    expect((d?.progress as Array<{ msg: string }>).map((e) => e.msg)).toEqual(["Agent: Grep pattern"]);
    expect((d?.events as Array<{ msg: string }>).map((e) => e.msg)).toEqual(["p4 sync 完成"]);
  });

  it("详情未找到返回 null", async () => {
    const w = makeWorker();
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([]));
    expect(await w.bugDetailForWeb("999999")).toBeNull();
  });

  it("不在列表时按 id 直拉详情", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287", description: "直接按 id 拉取" });
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([bug]));
    const d = await w.bugDetailForWeb(bug.id);
    expect(d?.title).toBe(bug.title);
    expect(d?.agent_state).toBeUndefined();
  });

  it("未处理 bug 跳过会落 skipped 记录", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    expect(await w.skipBug(bug.id)).toBe(true);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("skipped");
    // 从可处理队列消失
    expect(await w.fetchActionable()).toEqual([]);
  });

  it("跳过未知 bug 返回 false", async () => {
    const w = makeWorker();
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([]));
    expect(await w.skipBug("999999")).toBe(false);
    expect(w.store.getJob("999999")).toBeUndefined();
  });

  it("不在「分配给我」列表时跳过按 id 直拉", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([bug]));
    expect(await w.skipBug(bug.id)).toBe(true);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("skipped");
  });

  it("未处理 bug 重试为幂等成功", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    expect(await w.retryBug(bug.id)).toBe(true);
    expect(w.store.getJob(bug.id)).toBeUndefined();
  });

  it("已跳过 bug 可恢复为待处理并清除跳过完成状态", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, {
      agent_state: "skipped",
      failure_reason: "人工跳过",
      finished_at: "2026-08-28 10:00:00",
    });

    expect(await w.retryBug(bug.id)).toBe(true);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("pending");
    expect(job?.failure_reason).toBeNull();
    expect(job?.finished_at).toBeNull();
    expect(w.store.listEvents(bug.id).some((e) => String(e.msg).includes("从跳过恢复"))).toBe(true);
  });

  it("重试未知 bug 返回 false", async () => {
    const w = makeWorker();
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([]));
    expect(await w.retryBug("999999")).toBe(false);
  });

  it("已有 failed 记录的 bug 仍可跳过", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.upsertJob(bug, { agent_state: "failed" });
    expect(await w.skipBug(bug.id)).toBe(true);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// 本地任务可见可处理（回归：不在 Tapd「我的」列表的 bug 点重试毫无效果）
// ---------------------------------------------------------------------------
describe("本地任务（Tapd 列表外）可见可处理", () => {
  it("fetchActionable 纳入本地 pending（Tapd 直拉补全描述）", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []); // Tapd「我的」列表拉不到它
    stubTapd(w, new FakeTapd([bug])); // 但按 id 直拉能拉到
    w.store.upsertJob(bug, { agent_state: "pending" });

    const actionable = await w.fetchActionable();
    expect(actionable.map((b) => b.id)).toEqual([bug.id]);
    expect(actionable[0].description).toBe(bug.description); // 直拉补全了描述
  });

  it("Tapd 直拉也失败时用本地快照入队（不阻断）", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([])); // 直拉也失败
    w.store.upsertJob(bug, { agent_state: "pending" });

    const actionable = await w.fetchActionable();
    expect(actionable.map((b) => b.id)).toEqual([bug.id]);
    expect(actionable[0].title).toBe(bug.title); // 快照里有标题
    expect(actionable[0].description).toBe(""); // 描述缺失但仍在队列
  });

  it("快照 tapd_status 已终态（resolved）的本地 pending 不复活", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287", status: "resolved" });
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([bug]));
    w.store.upsertJob(bug, { agent_state: "pending" }); // upsert 落库 tapd_status=resolved

    expect(await w.fetchActionable()).toEqual([]);
  });

  it("回归：Tapd 确认无此单（直拉返回空壳）→ 本地 pending 自动转 skipped，不入队", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []);
    // REST/MCP 对不存在的单返回「只有 id 的空壳」（无标题无状态）
    stubTapd(w, {
      getBug: async (id: string) => makeBug({ id, title: "", status: "" }),
    } as unknown as FakeTapd);
    w.store.upsertJob(bug, { agent_state: "pending" });

    expect(await w.fetchActionable()).toEqual([]);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("skipped");
    expect(String(job?.failure_reason)).toContain("Tapd 单已不存在");
    const events = w.store.listEvents(bug.id);
    expect(events.some((e) => String(e.msg).includes("自动跳过"))).toBe(true);
  });

  it("回归：直拉抛错（接口波动）→ 保持 pending 用快照入队，不误杀", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []);
    stubTapd(w, {
      getBug: async () => { throw new Error("tapd 接口波动"); },
    } as unknown as FakeTapd);
    w.store.upsertJob(bug, { agent_state: "pending" });

    const actionable = await w.fetchActionable();
    expect(actionable.map((b) => b.id)).toEqual([bug.id]);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("pending"); // 没被误跳过
  });

  it("回归：列表拉取失败且直拉返回空壳时保持 pending，不误判单据不存在", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubTapd(w, {
      listBugs: async () => { throw new Error("fetch failed"); },
      getBug: async (id: string) => makeBug({ id, title: "", status: "" }),
    } as unknown as FakeTapd);
    w.store.upsertJob(bug, { agent_state: "pending" });

    const actionable = await w.fetchActionable();
    expect(actionable.map((b) => b.id)).toEqual([bug.id]);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("pending");
  });

  it("列表显示本地有记录但不在 Tapd 列表的 bug（tapd_missing 标记）", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, []);
    w.store.upsertJob(bug, { agent_state: "failed" });

    const rows = await w.listBugsForWeb();
    expect(rows.length).toBe(1);
    expect(rows[0].bug_id).toBe(bug.id);
    expect(rows[0].agent_state).toBe("failed");
    expect(rows[0].tapd_missing).toBe(true);
    expect(rows[0].title).toBe(bug.title);
  });

  it("retryAllFailed 重置全部失败任务，非失败状态不动", async () => {
    const w = makeWorker();
    const a = makeBug({ id: "1152729922001254287" });
    const b = makeBug({ id: "1152729922001254288" });
    const ok = makeBug({ id: "1152729922001254289" });
    w.store.upsertJob(a, { agent_state: "failed" });
    w.store.upsertJob(b, { agent_state: "failed" });
    w.store.upsertJob(ok, { agent_state: "accepted" });
    w.store.updateJob(a.id, {
      attempts: 2,
      failure_reason: "旧失败原因",
      retry_evidence: dumps([{ attempt: 1, at: "2026-08-11 09:00:00", failure_reason: "x", opened_files: [], agent_summary: "", manual_assets: [] }]),
      admission_score: 88,
      investigation: { root_cause: "旧根因" },
      verification: { verified: true },
      review_findings: { approved: true },
    });

    const n = w.retryAllFailed();
    expect(n).toBe(2);
    for (const job of [w.store.getJob(a.id), w.store.getJob(b.id)]) {
      expect(job?.agent_state).toBe("pending");
      expect(job?.attempts).toBe(0);
      expect(job?.failure_reason).toBeNull();
      expect(job?.retry_evidence).toBeNull();
      expect(job?.admission_score).toBeNull();
      expect(job?.investigation).toBeNull();
      expect(job?.verification).toBeNull();
      expect(job?.review_findings).toBeNull();
      expect(job?.finished_at).toBeNull();
    }
    expect(w.store.getJob(ok.id)?.agent_state).toBe("accepted");
    // 重置后进入可处理队列
    stubMyBugs(w, []);
    stubTapd(w, new FakeTapd([a, b]));
    expect((await w.fetchActionable()).length).toBe(2);
  });

  it("resyncFromTapd 保留候选/人工结论并按最新 Tapd 列表重建可重试队列", async () => {
    const w = makeWorker();
    const live1 = makeBug({ id: "1152729922001254287" }); // Tapd 上还在
    const live2 = makeBug({ id: "1152729922001254288", status: "resolved" }); // Tapd 终态 → 不同步
    const gone = makeBug({ id: "1152729922001254290" }); // 只有本地有（Tapd 列表外）→ 应被清掉
    stubMyBugs(w, [live1, live2]);
    w.store.upsertJob(live1, { agent_state: "accepted", changelist: 777 }); // 人工结论保留
    w.store.upsertJob(gone, { agent_state: "failed" });
    w.store.recordFeedback(live1.id, {
      outcome: "accepted_unchanged",
      reason: "人工确认正确",
      human_changed_lines: 0,
      submitted_changelist: 777,
    });
    w.store.addEvent("旧事件", "info", live1.id);
    expect(w.store.jobCount()).toBe(2);

    const r = await w.resyncFromTapd();
    expect(r.cleared).toBe(1);
    expect(r.preserved).toBe(1);
    expect(r.synced).toBe(1); // resolved 的不同步
    expect(w.store.jobCount()).toBe(1);
    const job = w.store.getJob(live1.id);
    expect(job?.agent_state).toBe("accepted");
    expect(job?.changelist).toBe(777);
    expect(w.store.getJob(gone.id)).toBeUndefined(); // Tapd 外的本地残留已清
    // 已接受任务保留终态，不重新进入队列
    const actionable = await w.fetchActionable();
    expect(actionable).toEqual([]);
    // 已保留任务的事件不丢失
    const evs = w.store.listEvents(undefined, 10);
    expect(evs.some((e) => String(e.msg).includes("重新同步"))).toBe(true);
    expect(evs.some((e) => String(e.msg) === "旧事件")).toBe(true);
    expect(w.store.listFeedback(live1.id)).toHaveLength(1); // 质量标签不是队列缓存，必须长期保留
    expect(w.store.qualityMetrics().accepted_unchanged).toBe(1);
  });

  it("resyncFromTapd 运行态拒绝（非运行才可用，后端同 UI 一道闸）", async () => {
    const w = makeWorker();
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    w.store.setControl("running");
    await expect(w.resyncFromTapd()).rejects.toThrow(/运行中不可清除同步/);
    // 记录未被清
    expect(w.store.jobCount()).toBe(0); // 尚未 upsert，仍是 0；改为先建再拒绝验证
    w.store.upsertJob(bug, { agent_state: "accepted" });
    await expect(w.resyncFromTapd()).rejects.toThrow();
    expect(w.store.jobCount()).toBe(1); // 拒绝时不动数据
    // 停止后可用
    w.store.setControl("stopped");
    const r = await w.resyncFromTapd();
    expect(r.synced).toBe(1);
    expect(r.preserved).toBe(1);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("accepted");
  });

  it("停止后当前任务尚未退出时拒绝清除同步，避免删除运行中任务的状态和日志", async () => {
    const w = makeWorker();
    w.store.setControl("stopped");
    w.currentBugId = "1152729922001254287";

    await expect(w.resyncFromTapd()).rejects.toThrow(/仍在停止中/);
  });
});

// ---------------------------------------------------------------------------
// 控制 / 取消
// ---------------------------------------------------------------------------
describe("worker 控制与取消", () => {
  it("start/pause/resume/stop 设置取消态", () => {
    const w = makeWorker();
    w.start();
    expect(w.cancelEvent.cancelled).toBe(false);
    w.pause();
    expect(w.cancelEvent.cancelled).toBe(true);
    expect(w.state).toBe("paused");
    w.resume();
    expect(w.cancelEvent.cancelled).toBe(false);
    expect(w.state).toBe("running");
    w.stop();
    expect(w.cancelEvent.cancelled).toBe(true);
    expect(w.state).toBe("stopped");
  });

  it("进程启动对账：遗留 in_progress 回退为 pending", async () => {
    const w = makeWorker();
    const a = makeBug({ id: "1152729922001254287" });
    const b = makeBug({ id: "1152729922001254288" });
    w.store.upsertJob(a, { agent_state: "in_progress", started_at: "2026-08-11 20:00:00" });
    w.store.upsertJob(b, { agent_state: "in_progress", started_at: "2026-08-11 20:30:00" });
    w.store.upsertJob(makeBug({ id: "1152729922001254289" }), { agent_state: "skipped" });

    (w as unknown as { reconcileStaleInProgress(): void }).reconcileStaleInProgress();

    expect(w.store.getJob(a.id)?.agent_state).toBe("pending");
    expect(w.store.getJob(a.id)?.started_at).toBeNull();
    expect(w.store.getJob(b.id)?.agent_state).toBe("pending");
    // 非 in_progress 的任务不受影响
    expect(w.store.getJob("1152729922001254289")?.agent_state).toBe("skipped");
    const ev = w.store.listEvents(a.id);
    expect(ev.some((e) => String(e.msg).includes("对账"))).toBe(true);
  });

  it("agent 被取消时 bug 回到 pending，不算失败", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);

    let gotCancel: unknown = null;
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async function (
      this: unknown,
      opts: { cancelEvent?: CancelEvent },
    ) {
      gotCancel = opts.cancelEvent;
      throw new AgentCancelledError("Agent 调用被人工取消");
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);

    await w.processBug(bug);

    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("pending");
    expect(job?.failure_reason).toBeNull();
    expect(gotCancel).toBe(w.cancelEvent); // worker 把取消事件传给 agent
    const events = w.store.listEvents(bug.id);
    expect(events.some((e) => String(e.msg).includes("人工中断"))).toBe(true);
    expect(events.some((e) => String(e.msg).includes("处理失败"))).toBe(false);
  });

  it("P4 扫描被暂停或关闭取消时 bug 回到 pending，不记为失败", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    vi.spyOn(P4Client.prototype, "opened").mockRejectedValue(new P4CancelledError("人工取消 P4"));

    await w.processBug(bug);

    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("pending");
    expect(job?.attempts).toBe(0);
    expect(w.store.listEvents(bug.id).some((e) => String(e.msg).includes("人工中断"))).toBe(true);
  });

  it("回归：人工跳过正在处理的 bug，中断后不把 skipped 覆盖回 pending", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    const oldEvt = w.cancelEvent;

    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80)); // 模拟在跑
      throw new AgentCancelledError("Agent 调用被人工取消");
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);

    w.currentBugId = bug.id;
    const processing = w.processBug(bug);
    await new Promise((r) => setTimeout(r, 20)); // 等 processBug 启动
    expect(await w.skipBug(bug.id)).toBe(true);
    await processing;
    w.currentBugId = null;

    // 旧取消令牌被置位（中断了在跑的尝试），worker 换了新令牌（后续 bug 不受影响）
    expect(oldEvt.cancelled).toBe(true);
    expect(w.cancelEvent).not.toBe(oldEvt);
    expect(w.cancelEvent.cancelled).toBe(false);
    // 人工设置的 skipped 保留，不被取消路径覆盖
    expect(w.store.getJob(bug.id)?.agent_state).toBe("skipped");
    const events = w.store.listEvents(bug.id);
    expect(events.some((e) => String(e.msg).includes("保留人工设置的状态"))).toBe(true);
  });

  it("重试正在处理的 bug：中断当前尝试并换新取消令牌", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug({ id: "1152729922001254287" });
    w.store.upsertJob(bug, { agent_state: "in_progress" });
    w.store.updateJob(bug.id, { attempts: 2, failure_reason: "旧失败" });

    const oldEvt = w.cancelEvent;
    w.currentBugId = bug.id;
    expect(await w.retryBug(bug.id)).toBe(true);
    w.currentBugId = null;

    expect(oldEvt.cancelled).toBe(true);
    expect(w.cancelEvent).not.toBe(oldEvt);
    expect(w.cancelEvent.cancelled).toBe(false);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("pending");
    expect(job?.attempts).toBe(0);
    expect(job?.failure_reason).toBeNull();
    expect(job?.retry_evidence).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 带证据的自动重试循环
// ---------------------------------------------------------------------------
describe("formatRetryEvidence", () => {
  it("空数组返回空串", () => {
    expect(formatRetryEvidence([])).toBe("");
    expect(formatRetryEvidence(undefined as unknown as never)).toBe("");
  });

  it("把失败证据压缩成提示文本", () => {
    const text = formatRetryEvidence([
      {
        attempt: 2,
        at: "2026-08-11 10:00:00",
        failure_reason: "测试未通过: assertion failed",
        opened_files: ["//depot/a.cpp", "//depot/b.h"],
        agent_summary: "改了登录逻辑",
        manual_assets: ["Assets/ui.prefab"],
      },
    ]);
    expect(text).toContain("第 2 次尝试");
    expect(text).toContain("测试未通过");
    expect(text).toContain("//depot/a.cpp");
    expect(text).toContain("改了登录逻辑");
    expect(text).toContain("Assets/ui.prefab");
    expect(text).toContain("重新开始");
  });
});

describe("worker 两阶段修复协议", () => {
  it("专用 P4 工作区正常完成后只做一次启动基线扫描", async () => {
    const repo: RepoConfig = {
      name: "game", path: "C:\\project", verify_cmds: [], preflight_reconcile: "once",
    };
    const w = makeWorker([repo]);
    const first = makeBug({ id: "1152729922001234007" });
    const second = makeBug({ id: "1152729922001234008" });
    stubTapd(w, { addComment: async () => {} } as unknown as FakeTapd);
    let agentCalls = 0;
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async () => {
      agentCalls += 1;
      return agentCalls % 2 === 1
        ? makeInvestigation("project:Source/Foo.cpp")
        : makeResult({ manual_assets: [{ path: "asset", reason: "manual" }], summary: "人工资源" });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    const preview = vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");

    await w.processBug(first);
    await w.processBug(second);

    // 1 次启动基线 + 每个 Bug 完成后各 1 次改动收集；第二个 Bug 没有重复前置扫描。
    expect(preview).toHaveBeenCalledTimes(3);
    expect(w.store.listEvents(second.id).some((event) =>
      String(event.msg).includes("跳过重复 reconcile 扫描"))).toBe(true);
  });

  it("同一 Bug 可只修改 Git 引擎目录并保留本地分支和 commit", async () => {
    const repo: RepoConfig = {
      name: "game",
      path: "C:\\project",
      verify_cmds: [],
      additional_dirs: [{
        name: "engine",
        path: "C:\\engine",
        vcs: "git",
        base_branch: "branch_0.7.0",
        author: "yangfan",
        verify_cmds: [],
      }],
    };
    const w = makeWorker([repo]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    const comments: string[] = [];
    stubTapd(w, { addComment: async (_id: string, text: string) => { comments.push(text); } } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      return calls.length === 1
        ? makeInvestigation("engine:Engine/Source/Foo.cpp")
        : makeResult({ changed_files: ["engine:Engine/Source/Foo.cpp"], summary: "修复引擎逻辑" });
    });
    const sync = vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(GitWorkspace.prototype, "prepareBranch").mockResolvedValue({
      baseBranch: "branch_0.7.0", baseCommit: "base", branch: "branch_0.7.0_yangfan20260707171730",
    });
    vi.spyOn(GitWorkspace.prototype, "changedFiles").mockResolvedValue(["Engine/Source/Foo.cpp"]);
    vi.spyOn(GitWorkspace.prototype, "diff").mockResolvedValue("--- a/Engine/Source/Foo.cpp\n+++ b/Engine/Source/Foo.cpp\n-old\n+fixed");
    vi.spyOn(GitWorkspace.prototype, "finalize").mockResolvedValue({
      branch: "branch_0.7.0_yangfan20260707171730",
      commit: "0123456789abcdef",
      files: ["Engine/Source/Foo.cpp"],
    });
    const createPending = vi.spyOn(P4Client.prototype, "createPending");

    await w.processBug(bug);

    expect(calls.every((call) => (call.additionalDirs as string[]).includes("C:\\engine"))).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(createPending).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
    expect(String(w.store.getJob(bug.id)?.files)).toContain("engine:Engine/Source/Foo.cpp");
    expect(comments.join("\n")).toContain("branch_0.7.0_yangfan20260707171730");
    expect(comments.join("\n")).toContain("0123456789abcdef");
  });

  it("普通 P4 Bug 调查时可读引擎仓库，但不创建 Git 分支且修改阶段不开放 Git 写目录", async () => {
    const repo: RepoConfig = {
      name: "game",
      path: "C:\\project",
      verify_cmds: [],
      additional_dirs: [{
        name: "engine",
        path: "C:\\engine",
        vcs: "git",
        base_branch: "branch_0.7.0",
        author: "yangfan",
        verify_cmds: [],
      }],
    };
    const w = makeWorker([repo]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      return calls.length === 1
        ? makeInvestigation("project:TypeScript/Src/Login.ts")
        : makeResult({ changed_files: ["project:TypeScript/Src/Login.ts"], summary: "修复客户端逻辑" });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ depot: "//depot/TypeScript/Src/Login.ts", action: "edit", changelist: "default", type: "text" }]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue(
      "--- a/TypeScript/Src/Login.ts\n+++ b/TypeScript/Src/Login.ts\n-old\n+fixed",
    );
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);
    const prepareBranch = vi.spyOn(GitWorkspace.prototype, "prepareBranch");

    await w.processBug(bug);

    expect(calls[0].additionalDirs).toEqual(["C:\\engine"]);
    expect(calls[1].additionalDirs).toEqual([]);
    expect(prepareBranch).not.toHaveBeenCalled();
    expect(w.store.listEvents(bug.id).some((event) =>
      String(event.msg).includes("不创建 Git 分支"))).toBe(true);
  });

  it("仅把计划修改根的验证命令交给 Agent", () => {
    const repo: RepoConfig = {
      name: "game",
      path: "C:\\project",
      verify_cmds: ["project-test"],
      additional_dirs: [{
        name: "engine",
        path: "C:\\engine",
        vcs: "git",
        base_branch: "main",
        author: "yangfan",
        verify_cmds: ["engine-test"],
      }],
    };
    const w = makeWorker([repo]);
    const verificationCommands = (w as unknown as {
      verificationCommands: (r: RepoConfig, files?: string[]) => string[];
    }).verificationCommands.bind(w);

    expect(verificationCommands(repo, ["project:TypeScript/Src/Foo.ts"]))
      .toEqual(["[project] project-test"]);
    expect(verificationCommands(repo, ["engine:Engine/Source/Foo.cpp"]))
      .toEqual(["[engine] engine-test"]);
  });

  it("跨目录修复失败时回滚本次 Git 分支", async () => {
    const repo: RepoConfig = {
      name: "game",
      path: "C:\\project",
      verify_cmds: [],
      additional_dirs: [{
        name: "engine", path: "C:\\engine", vcs: "git",
        base_branch: "main", author: "yangfan", verify_cmds: [],
      }],
    };
    const w = makeWorker([repo]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {} } as unknown as FakeTapd);
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(GitWorkspace.prototype, "prepareBranch").mockResolvedValue({
      baseBranch: "main", baseCommit: "base", branch: "main_yangfan20260707171730",
    });
    const rollback = vi.spyOn(GitWorkspace.prototype, "rollback").mockResolvedValue();
    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeInvestigation("engine:Engine/Source/Foo.cpp"))
      .mockResolvedValueOnce(makeResult({ ok: false, log: "agent failed" }));

    await w.processBug(bug);

    expect(rollback).toHaveBeenCalledOnce();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("failed");
  });

  it("启用 MCP 后资源 Bug 可准入，所有 Agent 阶段自动获得 MCP", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.mcp_servers = parseMcpServers({
      prefab_mcp2: {
        command: "python",
        cwd: "C:\\tmp",
        read_only_tools: ["lgui_ping"],
        automates_manual_keywords: ["prefab"],
      },
    });
    const bug = makeBug({
      title: "LGUI prefab 节点显示异常",
      description: "复现步骤：打开界面。预期结果：节点可见。实际结果：节点消失。",
    });
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      return calls.length === 1
        ? makeInvestigation("Content/UI/Test.prefab")
        : makeResult({ changed_files: ["Content/UI/Test.prefab"], summary: "MCP 已修改并回读验证" });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ depot: "//depot/Content/UI/Test.prefab", action: "edit", changelist: "default", type: "binary" }]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(calls.every((call) => !("unrealMcpMode" in call))).toBe(true);
    expect(calls[0].sandboxMode).toBe("read-only");
    expect(calls[1].sandboxMode).toBe("workspace-write");
    expect(calls[0].requiredMcpServers).toEqual(["prefab_mcp2"]);
    expect(calls[1].requiredMcpServers).toEqual(["prefab_mcp2"]);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("default changelist 存在无法归属的遗留文件时停止，绝不混入当前 Bug", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([
      { depot: "//depot/OtherBug.ts", action: "edit", changelist: "default", type: "text" },
    ]);

    await w.processBug(bug);

    expect(run).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("blocked_workspace");
    expect(Number(w.store.getJob(bug.id)?.attempts ?? 0)).toBe(0);
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("default changelist 不干净");
  });

  it("存在未 p4 edit 的本地改动时停止，避免 reconcile 后混入当前 Bug", async () => {
    const w = makeWorker([{
      name: "r", path: "C:\\tmp", verify_cmds: [], preflight_reconcile: "always",
    }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue(
      "//depot/OtherBug.ts - edit C:\\tmp\\OtherBug.ts",
    );

    await w.processBug(bug);

    expect(run).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("blocked_workspace");
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("未登记的本地改动");
  });

  it("先以只读工具调查，再把根因证据交给写入阶段", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) {
        return makeResult({
          raw_output: 'FINAL_RESULT: {"root_cause":"空引用来自缓存失效","evidence":["[观察] Login.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- login","before":"FAIL"},"planned_files":["Login.ts"],"confidence":0.9,"blocked_reasons":[]}',
        });
      }
      return makeResult({ changed_files: ["Login.ts"], summary: "修复缓存失效" });
    });
    const sync = vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" },
      ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue(
      "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
    );
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(calls).toHaveLength(2);
    expect(calls[0].tools).toEqual(["read", "grep", "find", "ls"]);
    expect(calls[0].sandboxMode).toBe("read-only");
    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith(["./Login.ts"]);
    expect(calls[1].sandboxMode).toBe("workspace-write");
    expect(String(calls[1].prompt)).toContain("空引用来自缓存失效");
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("调查首轮只有开场白时在同一 Agent 补充一轮并继续修复", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) return makeResult({ raw_output: "我会先阅读相关代码并定位根因。" });
      if (calls.length === 2) return makeInvestigation("Login.ts");
      return makeResult({ changed_files: ["Login.ts"], summary: "修复缓存失效" });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" }]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue("--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed");
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(calls).toHaveLength(3);
    expect(String(calls[1].prompt)).toContain("上一轮输出未完成");
    expect(String(calls[1].prompt)).toContain("我会先阅读相关代码");
    expect(calls[0].outputSchema).toBeDefined();
    expect(calls[1].outputSchema).toBe(calls[0].outputSchema);
    expect(calls[2].outputSchema).toBeDefined();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("调查补充轮仍不完整时转 needs_info 且不消耗 Bug 重试", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeResult({ raw_output: "我会先调查。" }))
      .mockResolvedValueOnce(makeResult({ raw_output: "仍在检查代码。" }));
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);

    await w.processBug(bug);

    expect(run).toHaveBeenCalledTimes(2);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("needs_info");
    expect(Number(job?.attempts ?? 0)).toBe(0);
    expect(String(job?.failure_reason)).toContain("调查结果缺少 root_cause");
  });

  it("P4 精确同步超时后进入工作区阻塞且不消耗 Bug 重试次数", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run").mockResolvedValue(
      makeInvestigation("project:Content/UI/Test.uasset"),
    );
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    const sync = vi.spyOn(P4Client.prototype, "sync").mockRejectedValue(
      new P4SyncTimeoutError("p4 sync ./Content/UI/Test.uasset 超时(600s)"),
    );

    await w.processBug(bug);

    expect(run).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith(["./Content/UI/Test.uasset"]);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("blocked_workspace");
    expect(Number(w.store.getJob(bug.id)?.attempts ?? 0)).toBe(0);
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("P4 精确同步超时");
  });

  it("P4 持续断线进入工作区阻塞且不消耗 Bug 重试次数", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run");
    vi.spyOn(P4Client.prototype, "opened").mockRejectedValue(
      new P4ConnectionError("p4 opened -c default 失败: Connect to server failed; WSAECONNREFUSED"),
    );

    await w.processBug(bug);

    expect(run).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("blocked_workspace");
    expect(Number(w.store.getJob(bug.id)?.attempts ?? 0)).toBe(0);
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("P4 服务当前不可用");
  });

  it("Codex 后端沿用同一编排，并按阶段切换沙箱", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.agent.backend = "codex";
    w.config.codex.model = "gpt-test";
    w.config.agent_timeout_s = 1800;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(CodexAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      return calls.length === 1
        ? makeInvestigation("Login.ts")
        : makeResult({ changed_files: ["Login.ts"], summary: "Codex 修复" });
    });
    const piRun = vi.spyOn(PiAgent.prototype, "run");
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" }]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue("--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed");
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(piRun).not.toHaveBeenCalled();
    expect(calls.map((call) => call.sandboxMode)).toEqual(["read-only", "workspace-write"]);
    expect(calls.map((call) => call.timeoutS)).toEqual([1800, 1800]);
    expect(calls[0].maxCommandExecutions).toBeUndefined();
    expect(calls[0].repeatedCommandLimit).toBeUndefined();
    expect(calls[0].outputSchema).toBeDefined();
    expect(calls[1].maxCommandExecutions).toBeUndefined();
    expect(calls[1].repeatedCommandLimit).toBeUndefined();
    expect(calls[1].outputSchema).toBeDefined();
    expect(w.store.getJob(bug.id)?.agent).toBe("codex");
    expect(w.store.getJob(bug.id)?.model).toBe("gpt-test");
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("诊断链接依赖 Chrome MCP，预检失败时阻塞且不消耗重试", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.agent.backend = "codex";
    w.config.max_attempts = 2;
    const bug = makeBug({
      description: "Crash 详情 https://crashsight.qq.com/crash-reporting/crashes/app/issue/report?pid=10",
    });
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(CodexAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      throw new AgentInfrastructureError("required MCP 预检失败: chrome_devtools: Connection closed");
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");

    await w.processBug(bug);

    expect(calls).toHaveLength(1);
    expect(calls[0].requiredMcpServers).toEqual(["chrome_devtools"]);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("blocked_workspace");
    expect(Number(w.store.getJob(bug.id)?.attempts ?? 0)).toBe(0);
  });

  it("Agent 超时后转 needs_info 且不自动重试", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.agent.backend = "codex";
    w.config.max_attempts = 2;
    const bug = makeBug();
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    vi.spyOn(CodexAgent.prototype, "run").mockRejectedValue(
      new AgentTimeoutError("Agent 调用超时(600s): codex"),
    );
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);

    await w.processBug(bug);

    expect(w.store.getJob(bug.id)?.agent_state).toBe("needs_info");
    expect(Number(w.store.getJob(bug.id)?.attempts ?? 0)).toBe(0);
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("超时");
  });

  it("仅在机器验证实际通过后调用 Reviewer 并标记评审通过", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.review.enabled = true;
    w.config.workspaces[0].repos[0].verify_cmds = ["   "];
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) {
        return makeResult({
          raw_output: 'FINAL_RESULT: {"root_cause":"空引用","evidence":["[观察] Login.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- login","before":"FAIL"},"planned_files":["Login.ts"],"confidence":0.9,"blocked_reasons":[]}',
        });
      }
      return makeResult({ changed_files: ["Login.ts"], summary: "修复空引用" });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { depot: "//depot/Login.ts", action: "edit", changelist: "default", type: "text" },
      ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue(
      "--- a/Login.ts\n+++ b/Login.ts\n-old\n+fixed",
    );
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(calls).toHaveLength(2);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
  });

  it("Agent 修改 planned_files 之外的文件时拒绝生成 changelist", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeResult({
        raw_output: 'FINAL_RESULT: {"root_cause":"空引用","evidence":["[观察] Login.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- login","before":"FAIL"},"planned_files":["Login.ts"],"confidence":0.9,"blocked_reasons":[]}',
      }))
      .mockResolvedValueOnce(makeResult({ changed_files: ["Login.ts"], summary: "修复空引用" }));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { depot: "//depot/Unrelated.ts", action: "edit", changelist: "default", type: "text" },
      ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    const createPending = vi.spyOn(P4Client.prototype, "createPending");

    await w.processBug(bug);

    expect(createPending).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("failed");
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("超出调查阶段计划范围");
  });

  it("修复 Agent 同时报告改动和阻塞时拒绝生成候选", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeInvestigation("Login.ts"))
      .mockResolvedValueOnce(makeResult({
        changed_files: ["Login.ts"],
        blocked_reasons: ["无法运行专项复现"],
        summary: "只完成了部分修改",
      }));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    const createPending = vi.spyOn(P4Client.prototype, "createPending");

    await w.processBug(bug);

    expect(createPending).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("failed");
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("仍有阻塞项");
  });

  it("Reviewer 拒绝后把结构化 finding 交回 Fixer，修正并复审通过", async () => {
    const w = makeWorker([{
      name: "r",
      path: "C:\\tmp",
      verify_cmds: ['node -e "process.exit(0)"'],
    }]);
    w.config.review.enabled = true;
    w.config.review.max_fix_rounds = 1;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(PiAgent.prototype, "run").mockImplementation(async (opts) => {
      calls.push(opts as unknown as Record<string, unknown>);
      if (calls.length === 1) {
        return makeResult({
          raw_output: 'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["Settings.ts"],"confidence":0.9,"blocked_reasons":[]}',
        });
      }
      if (calls.length === 2) {
        return makeResult({
          changed_files: ["Settings.ts"],
          manual_assets: [{ path: "Assets/Settings.prefab", reason: "需在 Unity 中调整绑定" }],
          summary: "首次修复",
        });
      }
      if (calls.length === 3) {
        return makeResult({
          raw_output: 'FINAL_RESULT: {"approved":false,"note":"错误路径遗漏","findings":[{"severity":"high","title":"失败时仍显示成功","file":"Settings.ts","line":50,"evidence":"catch 分支仍调用 showSuccess","required_action":"失败分支必须显示错误并返回"}]}',
        });
      }
      if (calls.length === 4) return makeResult({ changed_files: ["Settings.ts"], summary: "补齐失败路径" });
      return makeResult({ raw_output: 'FINAL_RESULT: {"approved":true,"note":"问题已修复","findings":[]}' });
    });
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { depot: "//depot/Settings.ts", action: "edit", changelist: "default", type: "text" },
      ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "diffUnified").mockResolvedValue(
      "--- a/Settings.ts\n+++ b/Settings.ts\n-old\n+fixed",
    );
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);

    expect(calls).toHaveLength(5);
    expect(calls[2].tools).toEqual(["read", "grep", "find", "ls"]);
    expect(calls[2].outputSchema).toBeDefined();
    expect(String(calls[3].prompt)).toContain("失败分支必须显示错误并返回");
    expect(calls[3].outputSchema).toBeDefined();
    expect(calls[4].tools).toEqual(["read", "grep", "find", "ls"]);
    expect(calls[4].outputSchema).toBe(calls[2].outputSchema);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("candidate_partial");
    expect(String(job?.manual_assets)).toContain("Assets/Settings.prefab");
  }, 10000);

  it("准入不通过时不调用 Agent，并记录需要补充的信息", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.quality.admission.min_score = 55;
    w.config.quality.admission.require_reproduction_signal = true;
    const bug = makeBug({ name: "功能异常", description: "不对", module: "" });
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    const run = vi.spyOn(PiAgent.prototype, "run");

    await w.processBug(bug);

    expect(run).not.toHaveBeenCalled();
    expect(w.store.getJob(bug.id)?.agent_state).toBe("needs_info");
    expect(String(w.store.getJob(bug.id)?.failure_reason)).toContain("复现");
  });
});

describe("worker 自动重试", () => {
  it("最终验证失败但已有代码改动时保留到 pending changelist", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    w.store.upsertJob(bug);
    w.store.updateJob(bug.id, { agent_state: "in_progress" });
    stubTapd(w, { addComment: async () => {} } as unknown as FakeTapd);
    const p4 = new P4Client("C:\\tmp", {});
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([
      { depot: "//depot/a.cpp", action: "edit", changelist: "default", type: "text" },
    ]);
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4567);

    await (w as unknown as {
      handleFailure: (b: Bug, e: unknown, p: P4Client, r: AgentResult) => Promise<void>;
    }).handleFailure(
      bug,
      new Error("测试未通过: 机器验证失败"),
      p4,
      makeResult({ changed_files: ["project:a.cpp"], summary: "已修复" }),
    );

    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("manual_review");
    expect(job?.changelist).toBe(4567);
    expect(job?.last_attempt_files).toBeNull();
  });

  it("Reviewer 基础设施异常时立即保留已验证候选，不遗留在 default", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug();
    w.store.upsertJob(bug);
    w.store.updateJob(bug.id, { agent_state: "in_progress" });
    stubTapd(w, { addComment: async () => {} } as unknown as FakeTapd);
    const p4 = new P4Client("C:\\tmp", {});
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([
      { depot: "//depot/a.ts", action: "edit", changelist: "default", type: "text" },
    ]);
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4568);

    await (w as unknown as {
      handleFailure: (b: Bug, e: unknown, p: P4Client, r: AgentResult) => Promise<void>;
    }).handleFailure(
      bug,
      new Error("Reviewer 异常退出(1): No API key found"),
      p4,
      makeResult({ changed_files: ["project:a.ts"], summary: "已通过机器验证" }),
    );

    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("manual_review");
    expect(job?.changelist).toBe(4568);
    expect(job?.attempts).toBe(1);
    expect(job?.last_attempt_files).toBeNull();
  });

  it("未耗尽重试次数回 pending，耗尽才 failed；重试前撤销遗留 default 文件", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug({ id: "1152729922001254287" });
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);

    vi.spyOn(PiAgent.prototype, "run").mockRejectedValue(new Error("测试未通过"));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    const openedA = [{ depot: "//depot/a.cpp", action: "edit", changelist: "default", type: "text" }];
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([]) // 首次开始前工作区干净
      .mockResolvedValueOnce(openedA) // 首次 Agent 失败后留下 default 文件
      .mockResolvedValueOnce(openedA) // 第二次开始时定位并撤销遗留文件
      .mockResolvedValueOnce([]) // 撤销后工作区恢复干净
      .mockResolvedValueOnce([]); // 第二次失败未留下新文件
    const revertCalls: string[][] = [];
    vi.spyOn(P4Client.prototype, "revert").mockImplementation(async function (
      this: unknown,
      files: string[],
    ) {
      revertCalls.push(files);
      return "";
    });

    // 第 1 次：失败，还有重试次数 → pending
    await w.processBug(bug);
    let job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("pending");
    expect(job?.attempts).toBe(1);
    expect(revertCalls).toEqual([]); // 首次无遗留文件
    const ev1 = JSON.parse(String(job?.retry_evidence)) as Array<Record<string, unknown>>;
    expect(ev1.length).toBe(1);
    expect(ev1[0].opened_files).toEqual(["//depot/a.cpp"]); // 只记 default
    expect(ev1[0].failure_reason).toContain("测试未通过");

    // 第 2 次：先撤销遗留文件，再失败 → 重试耗尽 → failed
    await w.processBug(bug);
    job = w.store.getJob(bug.id);
    expect(revertCalls).toEqual([["//depot/a.cpp"]]);
    expect(job?.agent_state).toBe("failed");
    expect(job?.attempts).toBe(2);
    const ev2 = JSON.parse(String(job?.retry_evidence)) as Array<Record<string, unknown>>;
    expect(ev2.length).toBe(2);
  });

  it("max_attempts=1（默认）首次失败即 failed，不重试", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    vi.spyOn(PiAgent.prototype, "run").mockRejectedValue(new Error("Agent 超时"));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);

    await w.processBug(bug);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("failed");
    expect(job?.attempts).toBe(1);
  });

  it("Tapd 失败评论只在最后一次失败回写，含总尝试次数", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 3;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    const comments: string[] = [];
    stubTapd(w, {
      addComment: async (id: string, text: string) => { comments.push(text); },
      updateBug: async () => {},
    } as unknown as FakeTapd);
    vi.spyOn(PiAgent.prototype, "run").mockRejectedValue(new Error("Agent 超时"));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([]);
    vi.spyOn(P4Client.prototype, "revert").mockResolvedValue("");

    await w.processBug(bug); // 第 1 次 → pending
    await w.processBug(bug); // 第 2 次 → pending
    await w.processBug(bug); // 第 3 次 → failed
    expect(comments.length).toBe(1);
    expect(comments[0]).toContain("已尝试 3 次");
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("failed");
    expect(job?.attempts).toBe(3);
    expect(JSON.parse(String(job?.retry_evidence)).length).toBe(3);
  });

  it("回归：修复成功只发 Tapd 评论，绝不自动修改单子状态（状态由人工 review/submit 后自行处理）", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    const comments: string[] = [];
    const statusUpdates: Array<Record<string, unknown>> = [];
    stubTapd(w, {
      addComment: async (_id: string, text: string) => { comments.push(text); },
      updateBug: async (_id: string, fields: Record<string, unknown>) => { statusUpdates.push(fields); },
    } as unknown as FakeTapd);

    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeInvestigation("a.cpp"))
      .mockResolvedValueOnce(makeResult({ changed_files: ["a.cpp"], summary: "修好了" }));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened")
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { depot: "//depot/a.cpp", action: "edit", changelist: "default", type: "text" },
      ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "createPending").mockResolvedValue(4321);

    await w.processBug(bug);
    expect(w.store.getJob(bug.id)?.agent_state).toBe("candidate");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("pending changelist: 4321");
    expect(comments[0]).toContain("状态未修改"); // 评文明示状态留给人工
    expect(statusUpdates).toEqual([]); // 一次 updateBug 都不许有
  });

  it("成功后清空重试证据与遗留文件记录", async () => {    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    w.store.upsertJob(bug); // 先建行，再预置历史证据（updateJob 对不存在的行是 no-op）
    w.store.updateJob(bug.id, {
      attempts: 1,
      retry_evidence: dumps([{
        attempt: 1, at: "2026-08-11 09:00:00", failure_reason: "上次失败",
        opened_files: ["//depot/a.cpp"], agent_summary: "", manual_assets: [],
      }]),
      last_attempt_files: dumps(["//depot/a.cpp"]),
    });

    const revertCalls: string[][] = [];
    const createPendingCalls: Array<{ desc: string; files?: string[] }> = [];
    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeInvestigation("a.cpp"))
      .mockResolvedValueOnce(makeResult({ changed_files: ["a.cpp"], summary: "修好了" }));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockResolvedValue([
      { depot: "//depot/a.cpp", action: "edit", changelist: "default", type: "text" },
    ]);
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "revert").mockImplementation(async function (
      this: unknown,
      files: string[],
    ) {
      revertCalls.push(files);
      return "";
    });
    vi.spyOn(P4Client.prototype, "createPending").mockImplementation(
      async (desc: string, files?: string[]) => {
        createPendingCalls.push({ desc, files });
        return 1234;
      },
    );

    await w.processBug(bug);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("candidate");
    expect(job?.retry_evidence).toBeNull();
    expect(job?.last_attempt_files).toBeNull();
    expect(job?.attempts).toBe(1);
    expect(revertCalls).toEqual([["//depot/a.cpp"]]); // 重试开始时清理了遗留文件
    // 成功路径：createPending 收到 Bug 单描述 + 只含当前 bug 的文件列表
    expect(createPendingCalls).toHaveLength(1);
    expect(createPendingCalls[0].desc).toContain("【b1234007】登录页偶现崩溃");
    expect(createPendingCalls[0].desc).toContain("登录页偶现崩溃");
    expect(createPendingCalls[0].files).toEqual(["//depot/a.cpp"]);
  });

  it("回归：FINAL_RESULT 解析失败但 p4 有打开文件时按事实采纳，不再误判失败（bug 1256834 实例）", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);

    // Agent 实际改了文件（p4 已打开），但最终输出没有可解析的 FINAL_RESULT
    vi.spyOn(PiAgent.prototype, "run")
      .mockResolvedValueOnce(makeInvestigation("fixed.ts"))
      .mockResolvedValueOnce(
        makeResult({ ok: true, summary: "", raw_output: "一堆没有结构化结果的文本" }),
      );
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    let openedCalls = 0;
    vi.spyOn(P4Client.prototype, "opened").mockImplementation(async (cl?: string) => {
      openedCalls += 1;
      if (openedCalls === 1 && cl === "default") return [];
      return [
        { depot: "//depot/fixed.ts", action: "edit", changelist: "default", type: "text" },
        // 编号 changelist 里是别的 bug 的文件，不能混进本次结果
        { depot: "//depot/other.ts", action: "edit", changelist: "737633", type: "text" },
      ].filter((o) => !cl || o.changelist === cl);
    });
    vi.spyOn(P4Client.prototype, "reconcilePreview").mockResolvedValue("");
    const createPendingCalls: Array<{ desc: string; files?: string[] }> = [];
    vi.spyOn(P4Client.prototype, "createPending").mockImplementation(
      async (desc: string, files?: string[]) => {
        createPendingCalls.push({ desc, files });
        return 737999;
      },
    );

    await w.processBug(bug);
    const job = w.store.getJob(bug.id);
    expect(job?.agent_state).toBe("candidate");
    expect(job?.changelist).toBe(737999);
    expect(createPendingCalls).toHaveLength(1);
    expect(createPendingCalls[0].files).toEqual(["//depot/fixed.ts"]); // 只含 default 文件
    const events = w.store.listEvents(bug.id);
    expect(events.some((e) => String(e.msg).includes("FINAL_RESULT"))).toBe(true);
  });

  it("回归：遗留文件已被并入编号 changelist 时不盲撤（避免误杀其它 bug 的 pending 改动）", async () => {
    const w = makeWorker([{ name: "r", path: "C:\\tmp", verify_cmds: [] }]);
    w.config.max_attempts = 2;
    const bug = makeBug();
    stubMyBugs(w, [bug]);
    stubTapd(w, { addComment: async () => {}, updateBug: async () => {} } as unknown as FakeTapd);
    w.store.upsertJob(bug);
    // 上次失败遗留记录里的文件，如今只剩编号 changelist 里的一份（default 已空）
    w.store.updateJob(bug.id, {
      attempts: 1,
      last_attempt_files: dumps(["//depot/gone.ts"]),
      agent_state: "pending",
    });

    const revertCalls: string[][] = [];
    vi.spyOn(PiAgent.prototype, "run").mockRejectedValue(new Error("模拟失败"));
    vi.spyOn(P4Client.prototype, "sync").mockResolvedValue("");
    vi.spyOn(P4Client.prototype, "opened").mockImplementation(async (cl?: string) => [
      { depot: "//depot/gone.ts", action: "edit", changelist: "737700", type: "text" },
    ].filter((o) => !cl || o.changelist === cl));
    vi.spyOn(P4Client.prototype, "revert").mockImplementation(async (files: string[]) => {
      revertCalls.push(files);
      return "";
    });

    await w.processBug(bug);
    expect(revertCalls).toEqual([]); // default 里没有它 → 不撤
    const job = w.store.getJob(bug.id);
    expect(JSON.parse(String(job?.last_attempt_files))).toEqual([]); // 记录已按 default 实况清空
  });
});

// ---------------------------------------------------------------------------
// ensurePiModels / effectivePiModel：config.yaml pi.provider → ~/.pi/agent/models.json 注入
// ---------------------------------------------------------------------------
describe("ensurePiModels", () => {
  it("provider 段完整时写入 models.json（apiKey 引用环境变量名，不落盘密钥）", () => {
    const dir = tmpdir();
    const file = path.join(dir, "models.json");
    const pi: Config["pi"] = {
      provider: {
        id: "kuro",
        base_url: "https://ai-gateway.kurogames.com",
        api_key_env: "ANTHROPIC_AUTH_TOKEN",
        auth_header: true,
        model_id: "claude-opus-4-8",
      },
    };
    ensurePiModels(pi, file);

    const root = JSON.parse(fs.readFileSync(file, "utf-8"));
    const p = root.providers.kuro;
    expect(p.baseUrl).toBe("https://ai-gateway.kurogames.com");
    expect(p.api).toBe("anthropic-messages");
    expect(p.apiKey).toBe("ANTHROPIC_AUTH_TOKEN"); // 环境变量名，不是密钥值
    expect(p.authHeader).toBe(true);
    expect(p.models).toHaveLength(1);
    expect(p.models[0]).toMatchObject({
      id: "claude-opus-4-8",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 32000,
    });
  });

  it("model_id 带 '/' 时 models.json 条目取最后一段；自定义参数生效", () => {
    const dir = tmpdir();
    const file = path.join(dir, "models.json");
    const pi: Config["pi"] = {
      provider: {
        id: "proxy",
        base_url: "https://proxy.example.com",
        api_key: "sk-literal",
        model_id: "proxy/sub-model", // 全限定名写法
        reasoning: false,
        context_window: 100000,
        max_tokens: 8000,
      },
    };
    ensurePiModels(pi, file);

    const p = JSON.parse(fs.readFileSync(file, "utf-8")).providers.proxy;
    expect(p.apiKey).toBe("sk-literal"); // 直接写 key 也支持（用户自行决定）
    expect(p.models[0]).toMatchObject({
      id: "sub-model", // 只写裸模型 id，--model 前缀由 effectivePiModel 拼
      reasoning: false,
      contextWindow: 100000,
      maxTokens: 8000,
    });
  });

  it("合并写入时保留已有其它 provider", () => {
    const dir = tmpdir();
    const file = path.join(dir, "models.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ providers: { other: { baseUrl: "https://x" } } }),
    );
    const pi: Config["pi"] = {
      provider: { id: "kuro", base_url: "https://gateway", model_id: "m" },
    };
    ensurePiModels(pi, file);

    const root = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(root.providers.other.baseUrl).toBe("https://x");
    expect(root.providers.kuro.baseUrl).toBe("https://gateway");
  });

  it("未配置 provider / 缺 base_url / 无 model_id 时不写文件", () => {
    const dir = tmpdir();
    const file = path.join(dir, "models.json");

    ensurePiModels({}, file); // 无 provider
    expect(fs.existsSync(file)).toBe(false);

    ensurePiModels(
      { provider: { id: "kuro", model_id: "m" } }, // 缺 base_url
      file,
    );
    expect(fs.existsSync(file)).toBe(false);

    ensurePiModels(
      { provider: { id: "kuro", base_url: "https://g" } }, // 无 model_id
      file,
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it("损坏的原文件不炸：从空结构重建", () => {
    const dir = tmpdir();
    const file = path.join(dir, "models.json");
    fs.writeFileSync(file, "{ 不是合法 json");
    ensurePiModels(
      { provider: { id: "kuro", base_url: "https://g", model_id: "m" } },
      file,
    );
    const root = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(root.providers.kuro.baseUrl).toBe("https://g");
  });
});

describe("effectivePiModel", () => {
  it("无 provider / 缺 model_id 返回空串", () => {
    expect(effectivePiModel({})).toBe("");
    expect(effectivePiModel({ provider: { id: "kuro" } })).toBe("");
    expect(effectivePiModel({ provider: { model_id: "m" } })).toBe("");
  });

  it("拼成 <provider>/<model_id>", () => {
    expect(effectivePiModel({ provider: { id: "kuro", model_id: "claude-opus-4-8" } }))
      .toBe("kuro/claude-opus-4-8");
  });

  it("model_id 已带 '/' 时原样返回", () => {
    expect(effectivePiModel({ provider: { id: "kuro", model_id: "kuro/claude-opus-4-8" } }))
      .toBe("kuro/claude-opus-4-8");
  });
});

// 回归：MCP 客户端必须先在业务方法里 connect()（listTools 填充 this.tools），
// 之后才能 toolFor() 匹配工具名。旧代码顺序颠倒导致 web 页拉不到 bug。
describe("TapdMcpClient 首次调用可发现工具", () => {
  beforeEach(() => {
    mcpMockState.tools = [
      { name: "tapd_get_bugs", description: "查询缺陷列表", inputSchema: { type: "object", properties: { workspace_id: { type: "number" }, current_owner: { type: "string" }, limit: { type: "number" }, page: { type: "number" } } } },
      { name: "tapd_update_bug", description: "更新缺陷", inputSchema: { type: "object", properties: { workspace_id: { type: "number" }, id: { type: "string" } } } },
    ];
    mcpMockState.callResult = {
      content: [{ type: "text", text: JSON.stringify([{ id: "1001", title: "测试缺陷", workspace_id: "52729922", status: "new" }]) }],
    };
  });

  it("listBugs 首次调用（无前置 connect）就能匹配工具并解析列表", async () => {
    const client = new TapdMcpClient("52729922", { transport: "stdio" });
    const bugs = await client.listBugs("me");
    expect(bugs).toHaveLength(1);
    expect(bugs[0].id).toBe("1001");
    expect(bugs[0].title).toBe("测试缺陷");
  });

  it("getBug 首次调用也能工作", async () => {
    const client = new TapdMcpClient("52729922", { transport: "stdio" });
    const bug = await client.getBug("1001");
    expect(bug.id).toBe("1001");
  });

  it("工具不可用时给出含可用清单的报错", async () => {
    mcpMockState.tools = [];
    const client = new TapdMcpClient("52729922", { transport: "stdio" });
    await expect(client.listBugs("me")).rejects.toThrow(/未找到适配 list_bugs/);
  });
});

describe("web 前端 bug_id 内插引号", () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "static", "index.html"),
    "utf-8",
  );

  it("actRetry/actSkip/actRestore 的 onclick 用引号包裹 bug_id（防 >2^53 被舍入成别的 bug）", () => {
    expect(html).toContain("actRetry('${job.bug_id}')");
    expect(html).toContain("actSkip('${job.bug_id}')");
    expect(html).toContain("actRestore('${job.bug_id}')");
    expect(html).not.toMatch(/act(Retry|Skip|Restore)\(\$\{job\.bug_id\}\)/);
  });

  it("跳过状态显示恢复入口，并在操作成功后等待刷新完成", () => {
    expect(html).toContain("job.agent_state === 'skipped'");
    expect(html).toContain("↻ 恢复为待处理");
    expect(html).toContain("async function actRestore(id)");
    expect(html).toMatch(/async function actSkip[\s\S]*?await refresh\(\)/);
    expect(html).toMatch(/async function actRestore[\s\S]*?await refresh\(\)/);
  });

  it("files/manual_assets/retry_evidence 用 parseArr 容错解析（防字面 'null' 导致 .length 崩溃）", () => {
    expect(html).toMatch(/parseArr\(job\.files\)/);
    expect(html).toMatch(/parseArr\(job\.manual_assets\)/);
    expect(html).toMatch(/parseArr\(job\.retry_evidence\)/);
    // 旧的裸 JSON.parse 必须移除
    expect(html).not.toContain("JSON.parse(job.files");
    expect(html).not.toContain("JSON.parse(job.manual_assets");
  });

  it("顶部有「重试全部失败」按钮并调 retry-failed 接口", () => {
    expect(html).toContain('id="btnRetryFailed"');
    expect(html).toContain("/api/retry-failed");
  });

  it("展示候选/验证/评审状态、质量指标，并可提交人工反馈", () => {
    expect(html).toContain("review_pending");
    expect(html).toContain("candidate_partial");
    expect(html).toContain("blocked_workspace");
    expect(html).toContain("stAcceptance");
    expect(html).toContain("/api/bugs/${id}/feedback");
    expect(html).toContain("accepted_unchanged");
    expect(html).toContain("rejected_wrong_root_cause");
    expect(html).toContain("reopened");
  });

  it("SSE 刷新不替换正在编辑的人工结论控件，并保留表单草稿", () => {
    expect(html).toContain("function feedbackEditorActive()");
    expect(html).toContain("let FEEDBACK_EDITING = false");
    expect(html).toMatch(/detailBody['"]\)\.addEventListener\(['"]pointerdown['"]/);
    expect(html).toMatch(/FEEDBACK_EDITING \|\| isFeedbackEditor\(document\.activeElement\)/);
    expect(html).toMatch(/sameJob && feedbackEditorActive\(\)/);
    expect(html).toContain("function feedbackDraft()");
    expect(html).toContain("restoreFeedbackDraft(draft)");
    expect(html).toMatch(/const selectedId = SELECTED_ID;[\s\S]*SELECTED_ID === selectedId/);
  });

  it("顶部有「清除并重新同步」按钮并调 resync 接口（含确认弹窗与进行中状态）", () => {
    expect(html).toContain('id="btnResync"');
    expect(html).toContain("/api/resync");
    expect(html).toMatch(/btnResync[\s\S]{0,600}confirm\(/); // 破坏性操作必须有确认
    expect(html).toContain("同步中"); // 防重复点击的禁用态文案
  });

  it("清除并重新同步仅非运行状态可用（运行中禁用 + 点击防线）", () => {
    // renderStatus 按控制态禁用
    expect(html).toMatch(/rs\.disabled = running/);
    // 点击处理器里再守一道（防 SSE 快照延迟竞态）
    expect(html).toMatch(/st0\.control === 'running'/);
    expect(html).toContain("请先「⏹ 关闭」停止自动处理");
  });

  it("api() 捕获网络错误并给出可见提示（回归：服务器重启窗口期点击毫无反馈）", () => {
    expect(html).toMatch(/catch \(e\) \{\s*\n?\s*\/\/ 服务器不可达/);
    expect(html).toContain("function toast(");
  });

  it("401 有补救入口：提示输入 token、记住并带参重载（回归：token 不匹配时 alert 死胡同）", () => {
    expect(html).not.toContain("alert('未授权");
    expect(html).toMatch(/401[\s\S]{0,400}prompt\('Web 管理台 token/);
    expect(html).toMatch(/localStorage\.setItem\('tapd_token'/);
  });

  it("成功请求后持久化 token，页面标题显示运行版本", () => {
    expect(html).toContain("// 请求成功 = 当前 token 有效，记住它");
    expect(html).toContain('id="verBadge"');
  });
});
