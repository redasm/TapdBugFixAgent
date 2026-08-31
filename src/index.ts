#!/usr/bin/env node
/** 命令行入口。
 *
 *   npm run dev -- serve        # 启动 Web 管理台 + 工作线程
 *   npm run dev -- run --once   # 无界面：处理最高优先级 1 个 bug
 *   npm run dev -- run          # 无界面：处理一批
 *   npm run dev -- list         # 只读：列出待处理 bug（按优先级）
 *   npm run dev -- mcp-tools    # 调试：连上 Tapd MCP 并打印发现的工具清单
 */

import { loadConfig, priorityRank, validateConfig, webToken } from "./config.js";
import { effectiveAgentModel, selectedAgentBackend } from "./agentBackend.js";
import { enabledMcpServerNames } from "./mcpServers.js";
import { StateStore } from "./state.js";
import { Worker } from "./worker.js";
import { createTapdClient } from "./tapd.js";
import { TapdMcpClient } from "./tapdMcp.js";
import type { Bug } from "./models.js";
import { evaluateFiles, parseRunSpec } from "./evaluationCli.js";

interface CliArgs {
  cmd: string;
  config: string;
  db: string;
  once: boolean;
  host?: string;
  port?: number;
  dataset?: string;
  results: Array<{ name: string; path: string }>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    cmd: "",
    config: "config.yaml",
    db: "tapd_agent_v2.db",
    once: false,
    results: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") {
      args.config = argv[++i] ?? args.config;
    } else if (a === "--db") {
      args.db = argv[++i] ?? args.db;
    } else if (a === "--once") {
      args.once = true;
    } else if (a === "--host") {
      args.host = argv[++i];
    } else if (a === "--port") {
      args.port = Number(argv[++i]);
    } else if (a === "--dataset") {
      args.dataset = argv[++i];
    } else if (a === "--result") {
      args.results.push(parseRunSpec(argv[++i] ?? ""));
    } else if (a.startsWith("-")) {
      throw new Error(`未知参数: ${a}`);
    } else {
      rest.push(a);
    }
  }
  args.cmd = rest[0] ?? "";
  return args;
}

function make(configPath: string, dbPath: string): { config: ReturnType<typeof loadConfig>; store: StateStore; worker: Worker } {
  const config = loadConfig(configPath);
  for (const problem of validateConfig(config)) console.log(`[配置警告] ${problem}`);
  const backend = selectedAgentBackend(config);
  const model = effectiveAgentModel(config, backend) || "(后端默认模型)";
  const mcpNames = enabledMcpServerNames(config.mcp_servers);
  console.log(`[启动] Agent backend=${backend}, model=${model}`);
  const p4IgnorePaths = config.workspaces.flatMap((workspace) => workspace.repos.flatMap((repo) => repo.ignore_paths ?? []));
  console.log(`[启动] P4 server=${String(config.p4.port ?? "(默认)")}, client=${String(config.p4.client ?? "(默认)")}, user=${String(config.p4.user ?? "(默认)")}, ignore_paths=${p4IgnorePaths.length ? p4IgnorePaths.join(", ") : "(无)"}`);
  for (const repo of config.workspaces.flatMap((workspace) => workspace.repos)) {
    for (const dir of repo.additional_dirs ?? []) {
      const ignored = dir.ignore_paths ?? [];
      console.log(
        `[启动] Git ${dir.name}=${dir.path}, base=${dir.base_branch}, ignore_paths=${ignored.length ? ignored.join(", ") : "(无)"}`,
      );
    }
  }
  console.log(`[启动] MCP enabled=${mcpNames.length ? mcpNames.join(", ") : "(无)"}`);
  console.log(`[启动] 工作区=${config.workspaces.flatMap((workspace) => workspace.repos.map((repo) => repo.path)).join(", ") || "(无)"}`);
  const store = new StateStore(dbPath);
  const worker = new Worker(config, store);
  return { config, store, worker };
}

async function cmdList(args: CliArgs): Promise<number> {
  const { config, store } = make(args.config, args.db);
  const rows: Array<{ bug: Bug; state: string }> = [];
  for (const ws of config.workspaces) {
    const client = createTapdClient(config, ws.workspace_id);
    try {
      const fetched = await client.listBugs(ws.owner);
      for (const b of fetched) {
        const job = store.getJob(b.id);
        rows.push({ bug: b, state: job?.agent_state ? String(job.agent_state) : "" });
      }
    } catch (exc) {
      console.log(`[error] workspace ${ws.workspace_id} 拉取失败: ${exc}`);
    }
  }
  // 对齐 Python：先按优先级排序（数字小优先），再按创建时间
  rows.sort((a, b) => {
    const byPriority = priorityRank(config, a.bug) - priorityRank(config, b.bug);
    if (byPriority !== 0) return byPriority;
    return (a.bug.created || "").localeCompare(b.bug.created || "");
  });
  console.log(`${"Bug ID".padStart(20)}  ${"优先级"}  ${"状态".padEnd(10)} 标题`);
  console.log("-".repeat(90));
  for (const r of rows) {
    const label = r.bug.priority_label || "-";
    const st = r.state || "未处理";
    console.log(`${r.bug.id.padStart(20)}  ${label.padEnd(4)} ${r.bug.status.padEnd(10)} ${st.padEnd(10)} ${r.bug.title.slice(0, 48)}`);
  }
  console.log(`\n共 ${rows.length} 个分配给我的 bug（含已处理的，见状态列）`);
  return 0;
}

async function cmdRun(args: CliArgs): Promise<number> {
  const { config, store, worker } = make(args.config, args.db);
  const limit = args.once ? 1 : config.max_bugs_per_run;
  const count = await worker.runBatch(limit);
  console.log(`处理完成 ${count} 个 bug`);
  const jobs = store.listJobs("all").slice(0, limit);
  for (const it of jobs) {
    const mark = ["candidate", "candidate_partial", "verified", "review_pending"].includes(
      String(it.agent_state),
    ) ? "✓" : "✗";
    console.log(`  ${mark} ${it.bug_id}  [${it.agent_state}]  changelist=${it.changelist}  ${String(it.title ?? "").slice(0, 40)}`);
  }
  return 0;
}

async function cmdServe(args: CliArgs): Promise<number> {
  const { config, store, worker } = make(args.config, args.db);
  // 服务重启不能沿用数据库里上次遗留的 running，否则页面尚未打开就会立刻跑 P4/Agent，
  // 与下方“默认关闭”的提示相矛盾，也容易和人工清除同步发生竞态。
  store.setControl("stopped");
  worker.startLoop();

  const { createApp } = await import("./web/app.js");
  const app = createApp(config, store, worker);
  const host = args.host ?? String(config.web.host ?? "127.0.0.1");
  const port = args.port ?? Number(config.web.port ?? 8080);
  const token = webToken(config);
  console.log(`管理台: http://${host}:${port}`);
  if (token) {
    console.log("Web token 已配置（为安全起见不在控制台显示）");
  } else {
    console.log("提示: 未配置 WEB_TOKEN，管理台无鉴权（仅建议本机使用）");
  }
  console.log("默认处于「关闭」状态，请在管理台点击「开启」开始自动处理。Ctrl+C 退出。");
  const server = app.listen(port, host, () => {
    console.log(`listening on ${host}:${port}`);
  });
  server.on("error", (err: Error) => {
    console.error(`[error] 监听失败 ${host}:${port}: ${err.message}`);
    void worker.shutdown();
    process.exit(1);
  });
  // 阻塞直到收到 SIGINT/SIGTERM 并由 shutdown 关闭 server 后返回（否则 main 会立即 process.exit）
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await worker.shutdown();
      server.close(() => resolve());
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
  return 0;
}

async function cmdMcpTools(args: CliArgs): Promise<number> {
  const { config } = make(args.config, args.db);
  const backend = String((config.tapd as Record<string, unknown>).backend ?? "rest");
  if (backend !== "mcp") {
    console.log("[error] 当前 backend 不是 mcp（config.yaml tapd.backend: mcp）");
    return 1;
  }
  const mcpCfg = (config.tapd as Record<string, unknown>).mcp ?? {};
  const wsId = config.workspaces[0]?.workspace_id ?? "";
  const client = new TapdMcpClient(wsId, mcpCfg as Record<string, unknown>);
  try {
    console.log(await client.dumpTools());
  } catch (exc) {
    console.log(`[error] 连接失败: ${exc}`);
    return 1;
  }
  return 0;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function cmdEval(args: CliArgs): Promise<number> {
  if (!args.dataset || !args.results.length) {
    console.error("eval 需要 --dataset <cases.jsonl> 和至少一个 --result <name=path>");
    return 1;
  }
  const reports = evaluateFiles(args.dataset, args.results);
  console.log("模型/Prompt             综合分  覆盖率  有效修复  验证通过  范围精确  评审通过  原样接受");
  console.log("-".repeat(100));
  for (const report of reports) {
    console.log(
      `${report.name.padEnd(22)} ${report.score.toFixed(3).padStart(6)}  `
      + `${percent(report.coverage).padStart(6)}  ${percent(report.effective_fix_rate).padStart(8)}  `
      + `${percent(report.verified_rate).padStart(8)}  ${percent(report.scope_precision).padStart(8)}  `
      + `${percent(report.review_pass_rate).padStart(8)}  ${percent(report.unchanged_acceptance_rate).padStart(8)}`,
    );
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    console.error((exc as Error).message);
    printHelp();
    return 1;
  }
  switch (args.cmd) {
    case "list":
      return cmdList(args);
    case "run":
      return cmdRun(args);
    case "serve":
      return cmdServe(args);
    case "mcp-tools":
      return cmdMcpTools(args);
    case "eval":
      return cmdEval(args);
    default:
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(`用法: tapd-bugfix <命令> [选项]
  list             只读：列出分配给我的待处理 bug（按优先级）
  run --once       无界面：处理最高优先级 1 个 bug
  run              无界面：处理一批
  serve            启动 Web 管理台 + 工作线程
  mcp-tools        调试：连上 Tapd MCP 并打印发现的工具清单
  eval             离线比较历史 Bug 的不同模型/Prompt 结果
选项:
  --config <path>  配置文件路径（默认 config.yaml）
  --db <path>      状态库路径（默认 tapd_agent_v2.db）
  --host <ip>      监听地址（serve，默认取配置）
  --port <n>       端口（serve，默认取配置）
  --dataset <path> eval 的历史 Bug JSONL 数据集
  --result <n=p>   eval 的结果 JSONL，可重复，例如 --result model-a=a.jsonl`);
}

const code = await main(process.argv.slice(2));
process.exit(code);
