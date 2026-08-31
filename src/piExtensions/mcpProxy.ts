import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface ServerConfig {
  name: string;
  required: boolean;
  command: string;
  url: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envVars: string[];
  bearerTokenEnvVar: string;
  httpHeaders: Record<string, string>;
  envHttpHeaders: Record<string, string>;
  enabledTools?: string[];
  disabledTools: string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

interface PiExtensionApi {
  registerTool(tool: Record<string, unknown>): void;
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
}

const configFromEnv = (): ServerConfig[] => {
  const raw = process.env.TAPD_BUGFIX_MCP_SERVERS;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("TAPD_BUGFIX_MCP_SERVERS 必须是数组");
  return parsed as ServerConfig[];
};

const toolName = (server: string, tool: string): string =>
  `${server}_${tool}`.replace(/[^a-zA-Z0-9_]/g, "_");

const resultContent = (result: Record<string, unknown>): Array<Record<string, unknown>> => {
  const content = Array.isArray(result.content) ? result.content : [];
  const mapped: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text") {
      mapped.push({ type: "text", text: String(block.text ?? "") });
      continue;
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      mapped.push({ type: "image", data: block.data, mimeType: block.mimeType });
      continue;
    }
    mapped.push({ type: "text", text: JSON.stringify(block) });
  }
  if (result.structuredContent !== undefined) {
    mapped.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  return mapped.length ? mapped : [{ type: "text", text: "MCP 工具执行完成（无文本输出）" }];
};

export default async function mcpProxyExtension(pi: PiExtensionApi): Promise<void> {
  const clients: Client[] = [];
  for (const server of configFromEnv()) {
    try {
      const client = new Client({ name: `tapd-bugfix-${server.name}`, version: "1.0.0" });
      const headers: Record<string, string> = { ...server.httpHeaders };
      for (const [header, envName] of Object.entries(server.envHttpHeaders ?? {})) {
        const value = process.env[envName];
        if (value !== undefined) headers[header] = value;
      }
      if (server.bearerTokenEnvVar) {
        const token = process.env[server.bearerTokenEnvVar];
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const transport = server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: Object.keys(headers).length ? { headers } : undefined,
        })
        : new StdioClientTransport({
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: { ...process.env, ...server.env } as Record<string, string>,
          stderr: "pipe",
        });
      await client.connect(transport, {
        timeout: Math.max(1, server.startupTimeoutSec) * 1000,
      });
      clients.push(client);
      const listed = await client.listTools();
      console.error(`[MCP ${server.name}] 加载成功，发现 ${listed.tools.length} 个工具`);
      for (const remote of listed.tools) {
        if (server.disabledTools.includes(remote.name)) continue;
        if (server.enabledTools && !server.enabledTools.includes(remote.name)) continue;
        pi.registerTool({
        name: toolName(server.name, remote.name),
        label: `${server.name}/${remote.name}`,
        description: `[MCP ${server.name}] ${remote.description ?? remote.name}`,
        promptSnippet: `Call ${server.name}/${remote.name} through MCP`,
        promptGuidelines: [
          "优先使用已暴露的 MCP 原子工具；任何写入后都要调用相应读取、diff 或检查工具验证结果。",
        ],
        parameters: remote.inputSchema as never,
        executionMode: "sequential",
        async execute(
          _toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) {
          const result = await client.callTool(
            { name: remote.name, arguments: params },
            undefined,
            { signal, timeout: Math.max(1, server.toolTimeoutSec) * 1000 },
          ) as Record<string, unknown>;
          const content = resultContent(result);
          if (result.isError) {
            throw new Error(content.map((item) => String(item.text ?? "")).join("\n"));
          }
          return {
            content,
            details: { server: server.name, tool: remote.name, structuredContent: result.structuredContent },
          };
        },
        });
      }
    } catch (error) {
      if (server.required) throw error;
      console.error(`[MCP ${server.name}] 加载失败，已跳过: ${(error as Error).message}`);
    }
  }
  pi.on("session_shutdown", async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
}
