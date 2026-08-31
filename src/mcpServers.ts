import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpServerConfig {
  enabled: boolean;
  required: boolean;
  command: string;
  url: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  env_vars: string[];
  bearer_token_env_var: string;
  http_headers: Record<string, string>;
  env_http_headers: Record<string, string>;
  enabled_tools?: string[];
  disabled_tools: string[];
  read_only_tools?: string[];
  automates_manual_keywords: string[];
  approval_mode: "auto" | "prompt" | "writes" | "approve";
  startup_timeout_sec: number;
  tool_timeout_sec: number;
}

export type McpServersConfig = Record<string, McpServerConfig>;

export interface ResolvedMcpServer {
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
  approvalMode: McpServerConfig["approval_mode"];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

export interface McpServerProbe {
  name: string;
  discoveredTools: string[];
  healthCheckTool?: string;
  error?: string;
}

export interface McpServerInspection extends McpServerProbe {
  required: boolean;
  availableTools: string[];
  missingEnabledTools: string[];
}

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
interface CodexConfigObject {
  [key: string]: CodexConfigValue;
}

const stringArray = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.map(String).map((item) => item.trim()).filter(Boolean)
  : undefined;

const stringMap = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => [key, String(item ?? "")],
  ));
};

const processEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export function parseMcpServers(value: unknown): McpServersConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const servers: McpServersConfig = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    servers[name] = {
      enabled: Boolean(item.enabled ?? true),
      required: Boolean(item.required ?? false),
      command: String(item.command ?? ""),
      url: String(item.url ?? ""),
      args: stringArray(item.args) ?? [],
      cwd: String(item.cwd ?? "{repo}"),
      env: stringMap(item.env),
      env_vars: stringArray(item.env_vars) ?? [],
      bearer_token_env_var: String(item.bearer_token_env_var ?? ""),
      http_headers: stringMap(item.http_headers),
      env_http_headers: stringMap(item.env_http_headers),
      enabled_tools: stringArray(item.enabled_tools),
      disabled_tools: stringArray(item.disabled_tools) ?? [],
      read_only_tools: stringArray(item.read_only_tools),
      automates_manual_keywords: stringArray(item.automates_manual_keywords) ?? [],
      approval_mode: String(item.approval_mode ?? "approve") as McpServerConfig["approval_mode"],
      startup_timeout_sec: Number(item.startup_timeout_sec ?? 20),
      tool_timeout_sec: Number(item.tool_timeout_sec ?? 60),
    };
  }
  return servers;
}

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expandPlaceholders = (value: string, repoDir: string): string => value
  .replaceAll("${repo}", repoDir)
  .replaceAll("{repo}", repoDir)
  .replaceAll("${agent}", agentRoot)
  .replaceAll("{agent}", agentRoot);

export function resolveMcpServers(
  configs: McpServersConfig,
  repoDir: string,
  readOnly: boolean,
): ResolvedMcpServer[] {
  return Object.entries(configs).flatMap(([name, config]) => {
    if (!config.enabled) return [];
    const enabledTools = readOnly
      ? [...(config.read_only_tools ?? [])]
      : config.enabled_tools ? [...config.enabled_tools] : undefined;
    return [{
      name,
      required: config.required,
      command: expandPlaceholders(config.command, repoDir),
      url: expandPlaceholders(config.url, repoDir),
      args: config.args.map((arg) => expandPlaceholders(arg, repoDir)),
      cwd: path.resolve(expandPlaceholders(config.cwd || "{repo}", repoDir)),
      env: Object.fromEntries(Object.entries(config.env).map(
        ([key, item]) => [key, expandPlaceholders(item, repoDir)],
      )),
      envVars: [...config.env_vars],
      bearerTokenEnvVar: config.bearer_token_env_var,
      httpHeaders: Object.fromEntries(Object.entries(config.http_headers).map(
        ([key, item]) => [key, expandPlaceholders(item, repoDir)],
      )),
      envHttpHeaders: { ...config.env_http_headers },
      enabledTools,
      disabledTools: [...config.disabled_tools],
      approvalMode: config.approval_mode,
      startupTimeoutSec: config.startup_timeout_sec,
      toolTimeoutSec: config.tool_timeout_sec,
    }];
  });
}

export function enabledMcpServerNames(configs: McpServersConfig): string[] {
  return Object.entries(configs).filter(([, config]) => config.enabled).map(([name]) => name);
}

export function automatableManualKeywords(configs: McpServersConfig): string[] {
  return [...new Set(Object.values(configs)
    .filter((config) => config.enabled)
    .flatMap((config) => config.automates_manual_keywords))];
}

/** 所有 MCP 声明可处理的资源关键词；即使 server 暂时禁用，也继续作为人工门禁关键词。 */
export function configuredManualKeywords(configs: McpServersConfig): string[] {
  return [...new Set(Object.values(configs)
    .flatMap((config) => config.automates_manual_keywords))];
}

/** 返回当前文本实际命中的已启用 MCP，供单次任务建立动态必需依赖。 */
export function mcpServerNamesMatchingText(configs: McpServersConfig, text: string): string[] {
  const lower = text.toLowerCase();
  return Object.entries(configs).flatMap(([name, config]) =>
    config.enabled && config.automates_manual_keywords.some((keyword) =>
      keyword.trim() && lower.includes(keyword.trim().toLowerCase()))
      ? [name]
      : [],
  );
}

export function piMcpToolName(server: string, tool: string): string {
  return `${server}_${tool}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function piReadOnlyMcpTools(servers: ResolvedMcpServer[]): string[] {
  return servers.flatMap((server) =>
    (server.enabledTools ?? []).map((tool) => piMcpToolName(server.name, tool)),
  );
}

export function mcpServerConnectionKey(server: ResolvedMcpServer): string {
  return JSON.stringify({
    name: server.name,
    command: server.command,
    url: server.url,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    envVars: server.envVars,
    bearerTokenEnvVar: server.bearerTokenEnvVar,
    httpHeaders: server.httpHeaders,
    envHttpHeaders: server.envHttpHeaders,
    startupTimeoutSec: server.startupTimeoutSec,
    toolTimeoutSec: server.toolTimeoutSec,
  });
}

const resultErrorText = (result: Record<string, unknown>): string => {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" ? [String(block.text ?? "")] : [];
  }).filter(Boolean).join("\n") || "MCP 健康检查返回 isError=true";
};

/**
 * 直接通过 MCP SDK 枚举服务工具，并对已知的无参数健康检查工具进行调用。
 * 这一步独立于模型，能区分“服务不可用”和“模型选错了 resources API”。
 */
export async function probeMcpServer(server: ResolvedMcpServer): Promise<McpServerProbe> {
  const client = new Client({ name: `tapd-bugfix-probe-${server.name}`, version: "1.0.0" });
  try {
    const headers: Record<string, string> = { ...server.httpHeaders };
    for (const [header, envName] of Object.entries(server.envHttpHeaders)) {
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
        env: { ...processEnv(), ...server.env },
        stderr: "pipe",
      });
    await client.connect(transport, {
      timeout: Math.max(1, server.startupTimeoutSec) * 1000,
    });
    const listed = await client.listTools(undefined, {
      timeout: Math.max(1, server.startupTimeoutSec) * 1000,
    });
    const discoveredTools = [...new Set(listed.tools.map((tool) => tool.name))].sort();
    const healthCheckTool = ["ping", "lgui_ping"].find((name) => discoveredTools.includes(name))
      ?? (server.name === "chrome_devtools" && discoveredTools.includes("list_pages")
        ? "list_pages"
        : undefined);
    if (healthCheckTool) {
      const result = await client.callTool(
        { name: healthCheckTool, arguments: {} },
        undefined,
        { timeout: Math.max(1, Math.min(15, server.startupTimeoutSec, server.toolTimeoutSec)) * 1000 },
      ) as Record<string, unknown>;
      if (result.isError) throw new Error(resultErrorText(result));
    }
    return { name: server.name, discoveredTools, healthCheckTool };
  } catch (error) {
    const rawError = (error as Error).message || String(error);
    const actionableError = server.name === "chrome_devtools" && /timed out|connection closed/i.test(rawError)
      ? `${rawError}；请在 Chrome 打开 chrome://inspect/#remote-debugging，确认远程调试已启用并允许本次连接`
      : rawError;
    return {
      name: server.name,
      discoveredTools: [],
      error: actionableError,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function inspectMcpServer(
  server: ResolvedMcpServer,
  probe: McpServerProbe,
): McpServerInspection {
  const allowed = probe.discoveredTools.filter((tool) =>
    !server.disabledTools.includes(tool)
      && (server.enabledTools === undefined || server.enabledTools.includes(tool)),
  );
  const missingEnabledTools = (server.enabledTools ?? []).filter(
    (tool) => !probe.discoveredTools.includes(tool),
  );
  return {
    ...probe,
    name: server.name,
    required: server.required,
    availableTools: allowed,
    missingEnabledTools,
  };
}

export function mcpToolGuidance(inspections: McpServerInspection[]): string {
  if (!inspections.length) return "";
  const inventory = inspections.map((item) => {
    if (item.error) return `- 服务 \`${item.name}\`：预检不可用（${item.error}），不要臆造或尝试其工具。`;
    const tools = item.availableTools.length
      ? item.availableTools.map((tool) => `\`${tool}\``).join(", ")
      : "（当前阶段未开放工具）";
    const health = item.healthCheckTool ? `；健康检查 \`${item.healthCheckTool}\` 已通过` : "";
    const missing = item.missingEnabledTools.length
      ? `；配置中未发现：${item.missingEnabledTools.map((tool) => `\`${tool}\``).join(", ")}`
      : "";
    return `- 服务 \`${item.name}\`：${tools}${health}${missing}`;
  }).join("\n");
  return `# MCP 工具调用约束
以下清单来自本次运行启动前的 MCP tools/list 实测，不是猜测：
${inventory}
- 需要执行上述能力时，必须直接调用对应 MCP tool，并严格使用清单中的 server 名和 tool 名。
- 禁止用 read_mcp_resource、list_mcp_resources 或 list_mcp_resource_templates 代替 tool 调用，也禁止把 tool 名当作 resource URI。
- 不要使用显示名、插件名或自行猜测的别名替代配置中的 server 名。`;
}

export function mcpServerConfigProblems(configs: McpServersConfig, repoDirs: string[]): string[] {
  const problems: string[] = [];
  for (const repoDir of repoDirs) {
    for (const server of resolveMcpServers(configs, repoDir, false)) {
      const label = `mcp_servers.${server.name}`;
      if (!server.command.trim() && !server.url.trim()) {
        problems.push(`${label} 必须配置 command 或 url`);
      }
      if (server.command.trim() && server.url.trim()) {
        problems.push(`${label} 不能同时配置 command 和 url`);
      }
      if (path.isAbsolute(server.command) && !fs.existsSync(server.command)) {
        problems.push(`${label}.command 不存在: ${server.command}`);
      }
      if (server.command.trim() && !fs.existsSync(server.cwd)) {
        problems.push(`${label}.cwd 不存在: ${server.cwd}`);
      }
      if (server.url.trim()) {
        try {
          new URL(server.url);
        } catch {
          problems.push(`${label}.url 不是有效 URL: ${server.url}`);
        }
      }
      if (!Number.isFinite(server.startupTimeoutSec) || server.startupTimeoutSec <= 0) {
        problems.push(`${label}.startup_timeout_sec 必须为正数`);
      }
      if (!Number.isFinite(server.toolTimeoutSec) || server.toolTimeoutSec <= 0) {
        problems.push(`${label}.tool_timeout_sec 必须为正数`);
      }
      if (!["auto", "prompt", "writes", "approve"].includes(server.approvalMode)) {
        problems.push(`${label}.approval_mode 必须是 auto、prompt、writes 或 approve`);
      }
    }
  }
  return [...new Set(problems)];
}

export function codexMcpConfig(servers: ResolvedMcpServer[]): CodexConfigObject {
  const mcpServers: CodexConfigObject = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      required: server.required,
      ...(server.url ? {
        url: server.url,
        ...(server.bearerTokenEnvVar ? { bearer_token_env_var: server.bearerTokenEnvVar } : {}),
        ...(Object.keys(server.httpHeaders).length ? { http_headers: server.httpHeaders } : {}),
        ...(Object.keys(server.envHttpHeaders).length ? { env_http_headers: server.envHttpHeaders } : {}),
      } : {
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        ...(server.envVars.length ? { env_vars: server.envVars } : {}),
      }),
      startup_timeout_sec: server.startupTimeoutSec,
      tool_timeout_sec: server.toolTimeoutSec,
      default_tools_approval_mode: server.approvalMode,
      ...(server.enabledTools !== undefined ? { enabled_tools: server.enabledTools } : {}),
      ...(server.disabledTools.length ? { disabled_tools: server.disabledTools } : {}),
    };
  }
  return servers.length ? { mcp_servers: mcpServers } : {};
}
