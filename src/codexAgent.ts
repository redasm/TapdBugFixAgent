/** 官方 Codex SDK 适配器：结构化事件流、阶段化沙箱、取消与超时。 */

import {
  Codex,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";

import {
  AgentCancelledError,
  CommandExecutionGuard,
  AgentInfrastructureError,
  AgentInvestigationLimitError,
  AgentRuntimeError,
  AgentTimeoutError,
  WriteProgressGuard,
  type AgentRunOptions,
  resultFromOutput,
} from "./agent.js";
import path from "node:path";
import { PROJECT_ROOT, type Config } from "./config.js";
import type { AgentResult } from "./models.js";
import { mediaLinksPrompt } from "./media.js";
import { startCodexMediaProxy, type CodexMediaProxy } from "./codexMediaProxy.js";
import { p4EnvFromConfig } from "./p4.js";
import {
  codexMcpConfig,
  inspectMcpServer,
  mcpServerConnectionKey,
  mcpToolGuidance,
  probeMcpServer,
  resolveMcpServers,
  type McpServerProbe,
  type ResolvedMcpServer,
} from "./mcpServers.js";

const processEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const compactCommandOutput = (output: string, maxLength = 240): string => {
  const compact = output.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= maxLength ? compact : `…${compact.slice(-(maxLength - 1))}`;
};

const isRipgrepCommand = (command: string): boolean =>
  /(?:^|[\s'";&|])rg(?:\.exe)?(?:\s|$)/i.test(command);

const hasRipgrepError = (output: string): boolean =>
  /(?:^|\r?\n)\s*(?:rg(?:\.exe)?:|regex parse error:)/i.test(output);

export { CommandExecutionGuard, WriteProgressGuard } from "./agent.js";

/** 仅加载用户明确提供的模型目录；不能把 GPT 的工具协议元数据套到兼容网关模型上。 */
export function ensureCodexModelCatalog(
  config: Config,
  _model: string,
): string | undefined {
  const configured = config.codex.model_catalog_json.trim();
  if (configured) {
    const expanded = configured.replaceAll("${agent}", PROJECT_ROOT).replaceAll("{agent}", PROJECT_ROOT);
    return path.resolve(config.config_path ? path.dirname(config.config_path) : PROJECT_ROOT, expanded);
  }
  return undefined;
}

export function progressFromCodexEvent(event: ThreadEvent): string | undefined {
  if (event.type === "thread.started") return `Codex: 线程 ${event.thread_id}`;
  if (event.type === "turn.started") return "Codex: 模型已接受请求，开始执行";
  if (event.type === "turn.completed") {
    return `Codex: 调用完成（输入 ${event.usage.input_tokens} tokens，输出 ${event.usage.output_tokens} tokens）`;
  }
  if (event.type === "turn.failed") return `Codex: 执行失败 · ${event.error.message}`;
  if (event.type === "error") return `Codex: ${event.message}`;
  if (event.type !== "item.completed" && event.type !== "item.started") return undefined;

  const item = event.item;
  if (item.type === "command_execution") {
    const command = item.command.slice(0, 160);
    if (event.type === "item.started") return `Codex: 执行命令 ${command}`;
    if (item.status === "completed") return `Codex: 完成命令 ${command}`;
    if (item.exit_code === 1 && isRipgrepCommand(item.command) && !hasRipgrepError(item.aggregated_output)) {
      const result = item.aggregated_output.trim() ? "已返回结果" : "未命中";
      return `Codex: 搜索${result}（rg exit 1） ${command}`;
    }
    const exitCode = item.exit_code === undefined ? "未知" : String(item.exit_code);
    const detail = compactCommandOutput(item.aggregated_output);
    return `Codex: 命令失败（exit ${exitCode}） ${command}${detail ? ` · ${detail}` : ""}`;
  }
  if (item.type === "file_change" && event.type === "item.completed") {
    return `Codex: 文件变更 ${item.changes.map((change) => change.path).join(", ").slice(0, 180)}`;
  }
  if (item.type === "mcp_tool_call") {
    const state = event.type === "item.started" ? "调用" : item.status === "completed" ? "完成" : "失败";
    const detail = event.type === "item.completed" && item.status === "failed" && item.error?.message
      ? ` · ${item.error.message}`
      : "";
    return `Codex: ${state}工具 ${item.server}/${item.tool}${detail}`;
  }
  if (item.type === "agent_message" && event.type === "item.completed") {
    const text = item.text.replace(/\s+/g, " ").trim();
    return text ? `Codex: ${text.slice(-180)}` : undefined;
  }
  if (item.type === "reasoning" && event.type === "item.completed") {
    const text = item.text.replace(/\s+/g, " ").trim();
    return text ? `Codex: ${text.slice(-180)}` : undefined;
  }
  if (item.type === "error") return `Codex: ${item.message}`;
  return undefined;
}

export function codexThreadOptions(
  opts: AgentRunOptions,
  config: Config["codex"],
  sandboxMode: SandboxMode,
): ThreadOptions {
  const model = opts.model?.trim() || config.model || "";
  return {
    workingDirectory: opts.repoDir,
    additionalDirectories: [...new Set(opts.additionalDirs ?? [])].sort(),
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy: config.approval_policy,
    networkAccessEnabled: config.network_access,
    model: model || undefined,
    modelReasoningEffort: config.reasoning_effort as ModelReasoningEffort,
  };
}

/**
 * 官方 Codex 服务支持在工具调用轮次中同时使用 outputSchema；部分 OpenAI 兼容网关
 * 会在收到该参数后直接返回一段计划文本，完全不再发出 shell/MCP tool calls。
 * 自定义 base_url 因此继续使用提示中的 FINAL_RESULT 文本协议，并由本项目严格解析。
 */
export function codexOutputSchema(
  opts: AgentRunOptions,
  config: Config["codex"],
): unknown {
  return config.base_url.trim() ? undefined : opts.outputSchema;
}

export class CodexAgent {
  readonly name = "codex";
  private readonly threads = new Map<string, Thread>();
  private readonly mcpProbes = new Map<string, Promise<McpServerProbe>>();

  constructor(private readonly config: Config) {}

  private probeFor(server: ResolvedMcpServer): Promise<McpServerProbe> {
    const key = mcpServerConnectionKey(server);
    let probe = this.mcpProbes.get(key);
    if (!probe) {
      // 一个 Bug 的调查/修复/评审共用同一个 Agent 实例。失败结果也缓存，避免可选
      // MCP 在每个阶段重复等待启动超时；环境恢复后人工重试会创建新 Agent 并重新探测。
      probe = probeMcpServer(server);
      this.mcpProbes.set(key, probe);
    }
    return probe;
  }

  private clientFor(servers: ResolvedMcpServer[], model: string, baseUrl?: string): Codex {
    const cfg = this.config.codex;
    const apiKey = cfg.api_key_env ? process.env[cfg.api_key_env] : undefined;
    const modelCatalog = ensureCodexModelCatalog(this.config, model);
    return new Codex({
      codexPathOverride: cfg.codex_path || undefined,
      baseUrl: baseUrl || cfg.base_url || undefined,
      apiKey,
      env: { ...processEnv(), ...p4EnvFromConfig(this.config.p4) },
      config: {
        ...codexMcpConfig(servers),
        ...(modelCatalog ? { model_catalog_json: modelCatalog } : {}),
        ...(cfg.context_window ? { model_context_window: cfg.context_window } : {}),
        ...(cfg.auto_compact_token_limit
          ? { model_auto_compact_token_limit: cfg.auto_compact_token_limit }
          : {}),
      },
    });
  }

  private threadFor(
    opts: AgentRunOptions,
    sandboxMode: SandboxMode,
    servers: ResolvedMcpServer[],
    baseUrl?: string,
  ): { key: string; thread: Thread } {
    const model = opts.model?.trim() || this.config.codex.model || "";
    const mcpKey = JSON.stringify(servers.map(mcpServerConnectionKey));
    const codexKey = JSON.stringify(this.config.codex);
    const additionalDirectories = [...new Set(opts.additionalDirs ?? [])].sort();
    const key = `${opts.repoDir}\0${additionalDirectories.join("\0")}\0${sandboxMode}\0${model}\0${mcpKey}\0${codexKey}\0${baseUrl ?? ""}`;
    let thread = this.threads.get(key);
    if (!thread) {
      thread = this.clientFor(servers, model, baseUrl).startThread(
        codexThreadOptions(opts, this.config.codex, sandboxMode),
      );
      this.threads.set(key, thread);
    }
    return { key, thread };
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const sandboxMode: SandboxMode = opts.sandboxMode
      ?? (opts.tools?.length ? "read-only" : "workspace-write");
    const model = opts.model?.trim() || this.config.codex.model || "(Codex 默认模型)";
    const selectedMcpServers = opts.mcpServers ?? opts.requiredMcpServers;
    const requestedMcpServers = selectedMcpServers === undefined
      ? undefined
      : new Set(selectedMcpServers);
    const servers = resolveMcpServers(
      this.config.mcp_servers,
      opts.repoDir,
      sandboxMode === "read-only",
    ).filter((server) => requestedMcpServers === undefined || requestedMcpServers.has(server.name));
    const requiredMcpServers = new Set(opts.requiredMcpServers ?? []);
    let endpoint = "OpenAI 默认服务";
    if (this.config.codex.base_url) {
      try { endpoint = new URL(this.config.codex.base_url).origin; }
      catch { endpoint = "自定义网关"; }
    }
    opts.onProgress?.(
      `Codex: 准备调用模型 ${model}（sandbox=${sandboxMode}，endpoint=${endpoint}，timeout=${opts.timeoutS}s）`,
    );
    if (servers.length) {
      opts.onProgress?.(
        `MCP: Codex 配置已注入 ${servers.length} 个服务：${servers.map((server) => server.name).join(", ")}`,
      );
    }
    const mediaText = mediaLinksPrompt(opts.media ?? []);
    let prompt = mediaText ? `${opts.prompt}\n\n${mediaText}` : opts.prompt;
    let usableServers = servers;
    if (!servers.length && requiredMcpServers.size) {
      throw new AgentInfrastructureError(
        `required MCP 预检失败: ${[...requiredMcpServers].map((name) => `${name}: 未启用或未配置`).join("；")}`,
      );
    }
    if (servers.length) {
      opts.onProgress?.("MCP: 正在预检服务并读取实际工具清单");
      const inspections = await Promise.all(servers.map(async (server) =>
        inspectMcpServer(server, await this.probeFor(server))));
      for (const inspection of inspections) {
        if (inspection.error) {
          opts.onProgress?.(`MCP: ${inspection.name} 预检失败 · ${inspection.error}`);
        } else {
          opts.onProgress?.(
            `MCP: ${inspection.name} 可用，发现 ${inspection.discoveredTools.length} 个工具`
              + (inspection.healthCheckTool ? `，${inspection.healthCheckTool} 已通过` : ""),
          );
          if (inspection.missingEnabledTools.length) {
            opts.onProgress?.(
              `MCP: ${inspection.name} 配置的工具不存在：${inspection.missingEnabledTools.join(", ")}`,
            );
          }
        }
      }
      const configuredNames = new Set(inspections.map((item) => item.name));
      const missingRequired = [...requiredMcpServers].filter((name) => !configuredNames.has(name));
      const requiredFailures = inspections.filter((item) =>
        (item.required || requiredMcpServers.has(item.name))
          && (item.error || item.missingEnabledTools.length));
      if (requiredFailures.length || missingRequired.length) {
        const details = [
          ...missingRequired.map((name) => `${name}: 未启用或未配置`),
          ...requiredFailures.map((item) =>
            `${item.name}: ${item.error || `缺少工具 ${item.missingEnabledTools.join(", ")}`}`),
        ].join("；");
        throw new AgentInfrastructureError(`required MCP 预检失败: ${details}`);
      }
      const unusableNames = new Set(inspections.filter((item) =>
        item.error || item.missingEnabledTools.length).map((item) => item.name));
      usableServers = servers.filter((server) => !unusableNames.has(server.name));
      if (unusableNames.size) {
        opts.onProgress?.(`MCP: 本次跳过不可用的可选服务：${[...unusableNames].join(", ")}`);
      }
      const guidance = mcpToolGuidance(inspections);
      if (guidance) prompt = `${prompt}\n\n${guidance}`;
    }
    let mediaProxy: CodexMediaProxy | undefined;
    if (opts.media?.length && this.config.codex.base_url.trim()) {
      mediaProxy = await startCodexMediaProxy(this.config.codex.base_url, opts.media);
      opts.onProgress?.(`Codex: 将 ${opts.media.length} 个远程媒体 URL 注入网关请求`);
    }
    const { key, thread } = this.threadFor(opts, sandboxMode, usableServers, mediaProxy?.baseUrl);
    const controller = new AbortController();
    let stoppedBy: "cancel" | "timeout" | "no_write" | undefined;
    const deadline = Date.now() + opts.timeoutS * 1000;
    const completionGraceMs = Math.max(0, opts.completionGraceSeconds ?? 0) * 1000;
    const hardDeadline = deadline + completionGraceMs;
    let lastProgressAt = Date.now();
    const commandGuard = new CommandExecutionGuard(
      opts.maxCommandExecutions,
      opts.repeatedCommandLimit,
    );
    const writeProgressGuard = new WriteProgressGuard(
      opts.maxReadOnlyExecutionsBeforeWrite,
    );
    const firstWriteDeadline = opts.maxSecondsBeforeWrite
      ? Date.now() + opts.maxSecondsBeforeWrite * 1000
      : Number.POSITIVE_INFINITY;
    const watchdog = setInterval(() => {
      if (opts.cancelEvent?.cancelled) {
        stoppedBy = "cancel";
        controller.abort();
      } else if (Date.now() > deadline
          && !(completionGraceMs > 0
            && Date.now() - lastProgressAt <= 10_000
            && Date.now() <= hardDeadline)) {
        stoppedBy = "timeout";
        controller.abort();
      } else if (!writeProgressGuard.hasWritten && Date.now() > firstWriteDeadline) {
        stoppedBy = "no_write";
        controller.abort();
      }
    }, 200);

    let finalResponse = "";
    const changedFiles = new Set<string>();
    const log: string[] = [];
    const started = Date.now();
    try {
      const { events } = await thread.runStreamed(prompt, {
        signal: controller.signal,
        outputSchema: codexOutputSchema(opts, this.config.codex),
      });
      for await (const event of events) {
        const progress = progressFromCodexEvent(event);
        if (progress) {
          lastProgressAt = Date.now();
          opts.onProgress?.(progress);
          log.push(progress);
        }
        if (event.type === "turn.failed") {
          throw new AgentRuntimeError(`Codex turn 失败: ${event.error.message}`);
        }
        if (event.type === "error") {
          throw new AgentRuntimeError(`Codex 事件流失败: ${event.message}`);
        }
        if (event.type === "item.completed") {
          if (event.item.type === "agent_message") finalResponse = event.item.text;
          if (event.item.type === "file_change" && event.item.status === "completed") {
            writeProgressGuard.observeWrite();
            for (const change of event.item.changes) {
              changedFiles.add(change.path);
              opts.onFileWrite?.(change.path);
            }
          }
        }
        if (event.type === "item.started" && event.item.type === "command_execution") {
          try {
            commandGuard.observe(event.item.command);
            writeProgressGuard.observeTool("command_execution", { command: event.item.command });
          } catch (error) {
            controller.abort();
            if (error instanceof AgentInvestigationLimitError) {
              throw new AgentInvestigationLimitError(
                error.message,
                [...log, finalResponse].filter(Boolean).join("\n").slice(-32000),
                writeProgressGuard.hasWritten,
              );
            }
            throw error;
          }
        }
        if (event.type === "item.started" && event.item.type === "mcp_tool_call") {
          try {
            const toolName = event.item.tool;
            commandGuard.observe(JSON.stringify({
              server: event.item.server,
              toolName,
            }));
            writeProgressGuard.observeTool(toolName, {});
          } catch (error) {
            controller.abort();
            if (error instanceof AgentInvestigationLimitError) {
              throw new AgentInvestigationLimitError(
                error.message,
                [...log, finalResponse].filter(Boolean).join("\n").slice(-32000),
                writeProgressGuard.hasWritten,
              );
            }
            throw error;
          }
        }
      }
      const result = resultFromOutput(finalResponse, 0);
      if (!result.changed_files.length && changedFiles.size) result.changed_files = [...changedFiles];
      result.log = log.slice(-30).join("\n");
      opts.onProgress?.(`Codex: 结果解析完成（耗时 ${Math.round((Date.now() - started) / 1000)}s）`);
      if (mediaProxy?.degraded()) {
        opts.onProgress?.("Codex: 当前接口拒绝多媒体内容块，已自动降级为普通 URL 并完成重试");
      }
      return result;
    } catch (error) {
      this.threads.delete(key);
      if (stoppedBy === "cancel") {
        opts.onProgress?.("Codex: 调用已被人工取消");
        throw new AgentCancelledError("Agent 调用被人工取消: codex");
      }
      if (stoppedBy === "timeout") {
        opts.onProgress?.(`Codex: 调用超时（${opts.timeoutS}s）`);
        throw new AgentTimeoutError(
          `Agent 调用超时(${opts.timeoutS}s): codex`,
          [...log, finalResponse].filter(Boolean).join("\n").slice(-32000),
          writeProgressGuard.hasWritten,
        );
      }
      if (stoppedBy === "no_write") {
        opts.onProgress?.(`Codex: ${opts.maxSecondsBeforeWrite}s 内仍未产生文件写入，停止无效停滞`);
        throw new AgentInvestigationLimitError(
          `实施阶段 ${opts.maxSecondsBeforeWrite}s 内仍未产生文件写入，已停止无效停滞`,
          [...log, finalResponse].filter(Boolean).join("\n").slice(-32000),
          false,
        );
      }
      opts.onProgress?.(`Codex: 调用异常 · ${(error as Error).message}`);
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError(`Codex Agent 执行失败: ${(error as Error).message}`);
    } finally {
      clearInterval(watchdog);
      if (mediaProxy) {
        this.threads.delete(key);
        await mediaProxy.close();
      }
    }
  }
}
