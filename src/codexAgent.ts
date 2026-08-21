/** 官方 Codex SDK 适配器：结构化事件流、阶段化沙箱、取消与超时。 */

import {
  Codex,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
} from "@openai/codex-sdk";

import {
  AgentCancelledError,
  AgentRuntimeError,
  type AgentRunOptions,
  resultFromOutput,
} from "./agent.js";
import type { Config } from "./config.js";
import type { AgentResult } from "./models.js";
import { p4EnvFromConfig } from "./p4.js";

const processEnv = (): Record<string, string> => Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export function progressFromCodexEvent(event: ThreadEvent): string | undefined {
  if (event.type === "thread.started") return `Codex: 线程 ${event.thread_id}`;
  if (event.type === "turn.failed") return `Codex: 执行失败 · ${event.error.message}`;
  if (event.type === "error") return `Codex: ${event.message}`;
  if (event.type !== "item.completed" && event.type !== "item.started") return undefined;

  const item = event.item;
  if (item.type === "command_execution") {
    const state = event.type === "item.started" ? "执行" : item.status === "completed" ? "完成" : "失败";
    return `Codex: ${state}命令 ${item.command.slice(0, 160)}`;
  }
  if (item.type === "file_change" && event.type === "item.completed") {
    return `Codex: 文件变更 ${item.changes.map((change) => change.path).join(", ").slice(0, 180)}`;
  }
  if (item.type === "mcp_tool_call") {
    const state = event.type === "item.started" ? "调用" : item.status === "completed" ? "完成" : "失败";
    return `Codex: ${state}工具 ${item.server}/${item.tool}`;
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

export class CodexAgent {
  readonly name = "codex";
  private readonly client: Codex;
  private readonly threads = new Map<string, Thread>();

  constructor(private readonly config: Config) {
    const cfg = config.codex;
    const apiKey = cfg.api_key_env ? process.env[cfg.api_key_env] : undefined;
    this.client = new Codex({
      codexPathOverride: cfg.codex_path || undefined,
      baseUrl: cfg.base_url || undefined,
      apiKey,
      env: { ...processEnv(), ...p4EnvFromConfig(config.p4) },
    });
  }

  private threadFor(opts: AgentRunOptions, sandboxMode: SandboxMode): { key: string; thread: Thread } {
    const model = opts.model?.trim() || this.config.codex.model || "";
    const key = `${opts.repoDir}\0${sandboxMode}\0${model}`;
    let thread = this.threads.get(key);
    if (!thread) {
      thread = this.client.startThread({
        workingDirectory: opts.repoDir,
        skipGitRepoCheck: true,
        sandboxMode,
        approvalPolicy: this.config.codex.approval_policy,
        networkAccessEnabled: this.config.codex.network_access,
        model: model || undefined,
        modelReasoningEffort: this.config.codex.reasoning_effort as ModelReasoningEffort,
      });
      this.threads.set(key, thread);
    }
    return { key, thread };
  }

  async run(opts: AgentRunOptions): Promise<AgentResult> {
    const sandboxMode: SandboxMode = opts.sandboxMode
      ?? (opts.tools?.length ? "read-only" : "workspace-write");
    const { key, thread } = this.threadFor(opts, sandboxMode);
    const controller = new AbortController();
    let stoppedBy: "cancel" | "timeout" | undefined;
    const deadline = Date.now() + opts.timeoutS * 1000;
    const watchdog = setInterval(() => {
      if (opts.cancelEvent?.cancelled) {
        stoppedBy = "cancel";
        controller.abort();
      } else if (Date.now() > deadline) {
        stoppedBy = "timeout";
        controller.abort();
      }
    }, 200);

    let finalResponse = "";
    const changedFiles = new Set<string>();
    const log: string[] = [];
    try {
      const { events } = await thread.runStreamed(opts.prompt, {
        signal: controller.signal,
        outputSchema: opts.outputSchema,
      });
      for await (const event of events) {
        const progress = progressFromCodexEvent(event);
        if (progress) {
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
            for (const change of event.item.changes) changedFiles.add(change.path);
          }
        }
      }
      const result = resultFromOutput(finalResponse, 0);
      if (!result.changed_files.length && changedFiles.size) result.changed_files = [...changedFiles];
      result.log = log.slice(-30).join("\n");
      return result;
    } catch (error) {
      this.threads.delete(key);
      if (stoppedBy === "cancel") throw new AgentCancelledError("Agent 调用被人工取消: codex");
      if (stoppedBy === "timeout") throw new AgentRuntimeError(`Agent 调用超时(${opts.timeoutS}s): codex`);
      if (error instanceof AgentRuntimeError) throw error;
      throw new AgentRuntimeError(`Codex Agent 执行失败: ${(error as Error).message}`);
    } finally {
      clearInterval(watchdog);
    }
  }
}