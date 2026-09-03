/** Agent 后端选择：保留 Pi，并可切换到官方 Codex SDK。 */

import { PiAgent, type AgentRunOptions } from "./agent.js";
import { CodexAgent } from "./codexAgent.js";
import type { AgentBackend, Config } from "./config.js";
import type { AgentResult } from "./models.js";

export interface CodingAgent {
  readonly name: AgentBackend;
  run(opts: AgentRunOptions): Promise<AgentResult>;
}

export function selectedAgentBackend(config: Config, override?: string): AgentBackend {
  if (override === "pi" || override === "codex") return override;
  return config.agent?.backend === "codex" ? "codex" : "pi";
}

export function effectiveAgentModel(
  config: Config,
  backend: AgentBackend = selectedAgentBackend(config),
): string {
  if (backend === "codex") return config.codex.model;
  const provider = config.pi.provider;
  if (!provider || !provider.id || !provider.model_id) return "";
  return provider.model_id.includes("/") ? provider.model_id : `${provider.id}/${provider.model_id}`;
}

/** 评审模型允许只写模型 id；Pi 后端下自动继承 provider 前缀和认证配置。 */
export function effectiveReviewModel(config: Config, backend: AgentBackend): string {
  const configured = config.review.model.trim();
  if (!configured) return effectiveAgentModel(config, backend);
  if (backend === "codex" || configured.includes("/")) return configured;
  const providerId = config.pi.provider?.id?.trim();
  return providerId ? `${providerId}/${configured}` : configured;
}

export function createCodingAgent(config: Config, override?: string): CodingAgent {
  const backend = selectedAgentBackend(config, override);
  return backend === "codex" ? new CodexAgent(config) : new PiAgent(config);
}
