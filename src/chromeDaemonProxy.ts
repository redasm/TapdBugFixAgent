/**
 * Persistent Chrome DevTools MCP proxy.
 *
 * Pi starts stdio MCP processes per run. Connecting each of those directly
 * with --autoConnect makes Chrome treat every turn as a new debugger client and
 * may show the permission dialog repeatedly. The official chrome-devtools CLI
 * ships a daemon; this small MCP facade keeps that daemon alive and forwards
 * tool calls to it, while the short-lived stdio facade can be recreated freely.
 *
 * 连接模式由 `CHROME_DEVTOOLS_MODE` 选择（详见 `./chromeDevtoolsConfig.ts`）：
 *
 * - `attach`（默认，保持既有行为）：`--auto-connect` 附着到用户自己启动的 Chrome。
 *   复用日常浏览器登录态，但受 Chrome 144+ `chrome://inspect/#remote-debugging`
 *   的连接授权约束，授权随连接生命周期失效。
 * - `managed`：由 MCP 自己以管道方式启动一个**项目专用、持久 profile** 的 Chrome。
 *   不经过该授权链路，登录态保存在专用 profile 里跨任务复用；初始需要在其中登录一次。
 *
 * 两种模式使用不同的 daemon 会话 id，因此各自的命名管道与 PID 文件互不干扰。
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  CHROME_CALL_TIMEOUT_ENV,
  CHROME_EXECUTABLE_ENV,
  CHROME_PROFILE_DIR_ENV,
  buildDaemonArgs,
  projectRootFromModuleUrl,
  resolveCallTimeoutMs,
  resolveChromeMode,
  resolveManagedProfileDir,
  resolveSessionId,
} from "./chromeDevtoolsConfig.js";

interface CliArg {
  type: "string" | "boolean" | "number" | "integer" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
}

interface CliCommand {
  description: string;
  args: Record<string, CliArg>;
}

interface DaemonResponse {
  success: boolean;
  result?: string;
  error?: string;
}

const require = createRequire(import.meta.url);
const packageJson = require.resolve("chrome-devtools-mcp/package.json");
const packageRoot = path.dirname(packageJson);
const moduleAt = (relativePath: string): string =>
  pathToFileURL(path.join(packageRoot, relativePath)).href;

const { commands } = await import(moduleAt("build/src/config/cli-options.js")) as {
  commands: Record<string, CliCommand>;
};
const { startDaemon, sendCommand } = await import(moduleAt("build/src/daemon/client.js")) as {
  startDaemon(args?: string[], sessionId?: string): Promise<void>;
  sendCommand(command: Record<string, unknown>, sessionId?: string, timeout?: number): Promise<DaemonResponse>;
};
const { isDaemonRunning, assertValidSessionId } = await import(
  moduleAt("build/src/daemon/utils.js")
) as {
  isDaemonRunning(sessionId?: string): boolean;
  assertValidSessionId(sessionId?: string): void;
};

/** MCP 的 stdout 是 JSON-RPC 通道，诊断信息只能走 stderr。 */
const note = (text: string): void => {
  process.stderr.write(`[chrome-devtools-proxy] ${text}\n`);
};

const resolvedMode = resolveChromeMode(process.env.CHROME_DEVTOOLS_MODE);
if (resolvedMode.warning !== undefined) note(resolvedMode.warning);
const mode = resolvedMode.mode;
const sessionId = resolveSessionId(mode);
assertValidSessionId(sessionId);

const projectRoot = projectRootFromModuleUrl(import.meta.url);
let profileDir: string | undefined;
if (mode === "managed") {
  profileDir = resolveManagedProfileDir(projectRoot, process.env[CHROME_PROFILE_DIR_ENV]);
  try {
    // 官方 launch() 只在走默认目录时才自建目录；显式 user-data-dir 交给 Chrome 创建，
    // 失败时报错很含糊。这里提前建好并给出可定位的失败原因。
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `managed 模式无法创建专用 Chrome profile 目录: ${profileDir} (${(error as Error).message})。`
      + ` 可用 ${CHROME_PROFILE_DIR_ENV} 指向一个可写目录；指向 workspace 之外时可能需要正式审批。`,
    );
  }
}

const daemonArgs = buildDaemonArgs(mode, {
  profileDir,
  executablePath: process.env[CHROME_EXECUTABLE_ENV],
});
const callBudget = resolveCallTimeoutMs(process.env[CHROME_CALL_TIMEOUT_ENV]);
if (callBudget.warning !== undefined) note(callBudget.warning);
note(`模式=${mode} sessionId=${sessionId} 调用预算=${callBudget.timeoutMs}ms`
  + `${profileDir === undefined ? "" : ` profile=${profileDir}`}`);

let starting: Promise<void> | undefined;
const ensureDaemon = async (): Promise<void> => {
  if (isDaemonRunning(sessionId)) return;
  starting ??= startDaemon(daemonArgs, sessionId).finally(() => {
    starting = undefined;
  });
  await starting;
};

const jsonType = (arg: CliArg): Record<string, unknown> => {
  const schema: Record<string, unknown> = {
    type: arg.type === "integer" ? "integer" : arg.type,
  };
  if (arg.type === "array") schema.items = { type: "string" };
  if (arg.description) schema.description = arg.description;
  if (arg.default !== undefined) schema.default = arg.default;
  if (arg.enum?.length) schema.enum = arg.enum;
  return schema;
};

const tools = Object.entries(commands).map(([name, command]) => ({
  name,
  description: command.description,
  inputSchema: {
    type: "object" as const,
    properties: Object.fromEntries(Object.entries(command.args).map(
      ([argName, arg]) => [argName, jsonType(arg)],
    )),
    required: Object.entries(command.args).filter(([, arg]) => arg.required).map(([argName]) => argName),
    additionalProperties: false,
  },
}));

/** 两种模式的失败处置不同，提示文案必须分开，否则会把用户引向错误的排查方向。 */
const daemonFailureHint = (): string => (
  mode === "managed"
    ? `请在项目专用 Chrome 中完成首次登录；若浏览器未启动，确认本机已安装 Chrome 或用 ${CHROME_EXECUTABLE_ENV} 指定可执行文件。`
      + " 专用 Chrome 冷启动可能较慢，首次调用失败可重试一次。"
    : "请在 Chrome 144+ 的 chrome://inspect/#remote-debugging 启用远程调试，并在 Chrome 弹出的连接授权中允许一次。"
);

const server = new Server(
  { name: "tapd-bugfix-chrome-daemon-proxy", version: "1.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  if (!(tool in commands)) {
    return { isError: true, content: [{ type: "text", text: `未知 Chrome 工具: ${tool}` }] };
  }
  try {
    // 一份预算覆盖「daemon 就绪 + 工具调用」两段等待，避免两层超时叠加后越过外层 MCP
    // 客户端的 tool_timeout_sec（当前 90s）：代理必须先超时并给出可读原因。
    const deadline = Date.now() + callBudget.timeoutMs;
    await ensureDaemon();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`daemon 未在 ${callBudget.timeoutMs}ms 调用预算内就绪`);
    }
    const response = await sendCommand({
      method: "invoke_tool",
      tool,
      args: request.params.arguments ?? {},
    }, sessionId, remainingMs);
    if (!response.success) {
      return { isError: true, content: [{ type: "text", text: response.error || "Chrome daemon 调用失败" }] };
    }
    return JSON.parse(response.result || "{}") as Record<string, unknown>;
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Chrome daemon 不可用: ${(error as Error).message}。${daemonFailureHint()}`,
      }],
    };
  }
});

await ensureDaemon();
await server.connect(new StdioServerTransport());
