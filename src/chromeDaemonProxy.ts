/**
 * Persistent Chrome DevTools MCP proxy.
 *
 * Codex starts stdio MCP processes per turn. Connecting each of those directly
 * with --autoConnect makes Chrome treat every turn as a new debugger client and
 * may show the permission dialog repeatedly. The official chrome-devtools CLI
 * ships a daemon; this small MCP facade keeps that daemon alive and forwards
 * tool calls to it, while the short-lived stdio facade can be recreated freely.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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

const sessionId = process.env.CHROME_DEVTOOLS_SESSION_ID || "74617064";
assertValidSessionId(sessionId);

const daemonArgs = ["--viaCli", "--auto-connect", "--no-performance-crux"];

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

const server = new Server(
  { name: "tapd-bugfix-chrome-daemon-proxy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  if (!(tool in commands)) {
    return { isError: true, content: [{ type: "text", text: `未知 Chrome 工具: ${tool}` }] };
  }
  try {
    await ensureDaemon();
    const response = await sendCommand({
      method: "invoke_tool",
      tool,
      args: request.params.arguments ?? {},
    }, sessionId, 120000);
    if (!response.success) {
      return { isError: true, content: [{ type: "text", text: response.error || "Chrome daemon 调用失败" }] };
    }
    return JSON.parse(response.result || "{}") as Record<string, unknown>;
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Chrome daemon 不可用: ${(error as Error).message}。请只在 Chrome 重启后重新允许一次远程调试连接。`,
      }],
    };
  }
});

await ensureDaemon();
await server.connect(new StdioServerTransport());

