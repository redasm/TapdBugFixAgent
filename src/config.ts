/** 配置加载：config.yaml + .env（环境变量优先）。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import type { AdmissionPolicy } from "./quality.js";
import {
  mcpServerConfigProblems,
  parseMcpServers,
  type McpServersConfig,
} from "./mcpServers.js";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..",
);

export const DEFAULT_PRIORITY_WEIGHT: Record<string, number> = {
  urgent: 0, high: 0, "1": 0, "高": 0,
  medium: 1, "2": 1, "中": 1,
  low: 2, "3": 2, "低": 2,
  "4": 3,
};
export const DEFAULT_EXCLUDE_STATUS = ["resolved", "closed", "rejected"];

export type AgentBackend = "pi" | "codex";

export interface AgentSelectionConfig {
  /** 主修复后端；默认 pi，便于平滑升级和 A/B 对照。 */
  backend: AgentBackend;
}

export interface CodexConfig {
  /** 空值使用本机 Codex 配置的默认模型。 */
  model: string;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  approval_policy: "never" | "on-request" | "on-failure" | "untrusted";
  network_access: boolean;
  /** 可选兼容网关；空值使用 Codex 默认服务。 */
  base_url: string;
  /** API Key 所在环境变量名；空值时沿用 Codex CLI 登录状态。 */
  api_key_env: string;
  /** 可选自定义 codex 可执行文件路径。 */
  codex_path: string;
  /** 可选 Codex 模型目录；只接受与实际模型匹配的显式目录，禁止套用其他模型模板。 */
  model_catalog_json: string;
  /** 自定义/网关模型的上下文窗口，避免 Codex 使用未知模型回退值。 */
  context_window: number;
  /** 自动压缩触发 token 数；应小于 context_window。 */
  auto_compact_token_limit: number;
}

export interface RepoConfig {
  name: string;
  path: string;
  /** 按顺序执行的机器验证命令。 */
  verify_cmds: string[];
  /** P4 工作区中允许保留的本地生成路径；不参与脏检查、reconcile、diff 或 changelist。 */
  ignore_paths?: string[];
  /** 启动前全目录脏扫描频率；大型专用 Agent 工作区推荐 never。 */
  preflight_reconcile?: "always" | "once" | "never";
  /** 与主 P4 工作区共同交给 Agent 的附加代码目录。 */
  additional_dirs?: AdditionalDirConfig[];
}

export interface AdditionalDirConfig {
  /** Prompt 和结果文件列表中的稳定根别名，例如 engine。 */
  name: string;
  path: string;
  vcs: "git";
  /** 每个 Bug 都从该本地主分支创建独立修复分支。 */
  base_branch: string;
  /** 修复分支作者段；空值时回退到 p4.user / workspace.owner。 */
  author: string;
  /** 在该目录中按顺序执行的机器验证命令。 */
  verify_cmds: string[];
  /** 允许保留的本地生成路径；相对 Git 根目录，不参与干净检查、diff、提交或失败回滚。 */
  ignore_paths?: string[];
}

export interface WorkspaceConfig {
  workspace_id: string;
  owner: string;
  repos: RepoConfig[];
  default_repo: string;
}

/** 自定义 pi provider 配置（对应 ~/.pi/agent/models.json 的 providers.<id>）。
 *  配置了 provider 段时，agent 会在 spawn pi 前自动合并写入 models.json。
 *  api_key_env / api_key 二选一：推荐 api_key_env（环境变量名，运行期解析，不落盘）。
 */
export interface PiProviderConfig {
  id: string;                  // provider id（--model 前缀，如 kuro）
  base_url?: string;           // 网关/中转地址，如 https://ai-gateway.kurogames.com
  api_key_env?: string;        // 从环境变量读 key（推荐，密钥不落盘），如 ANTHROPIC_AUTH_TOKEN
  api_key?: string;            // 或直接写 key（不推荐，落盘明文）
  auth_header?: boolean;       // true = Authorization: Bearer（本司网关协议）；false = 默认 x-api-key
  model_id?: string;           // 模型 id（构造 `--model <provider>/<model_id>`）；必填（配合 provider 段）
  reasoning?: boolean;         // 默认 true
  context_window?: number;     // 默认 200000
  max_tokens?: number;         // 默认 32000
}

export interface PiConfig {
  provider?: PiProviderConfig; // 配置了 provider 时自动合并写入 models.json；否则 pi 用默认鉴权/模型
  /** 额外 skill 目录（相对仓库根或绝对路径）：spawn pi 时逐个 `--skill` 挂载。
   *  团队仓库共享的 .agents/skills / .agent/skills 默认就会尝试，无需配置；
   *  此字段用于覆盖默认或追加。 */
  skill_dirs?: string[];
}

export interface QualityConfig {
  admission: AdmissionPolicy;
  /** 没有任何验证命令时只产出 candidate，不允许标记 verified。 */
  require_verification: boolean;
  max_changed_files: number;
  max_diff_lines: number;
}

export interface ReviewConfig {
  enabled: boolean;
  /** 可选 Reviewer 后端；空值沿用主修复后端。 */
  backend: "" | AgentBackend;
  /** Reviewer 拒绝后允许 Fixer 定向修正的轮数。 */
  max_fix_rounds: number;
  /** 可选独立评审模型；空值沿用修复模型。 */
  model: string;
}

/** Web 设置页可编辑的配置项，持久化到 overrides.yaml（不重写带注释的 config.yaml）。
 *  loadConfig 启动时按"字段级合并"应用，优先级最高（覆盖 config.yaml 与 .env）。
 *  空字符串/undefined 的字段视为"保持不变"，不会被写入或覆盖。 */
export interface SettingsOverrides {
  agent?: Partial<AgentSelectionConfig>;
  codex?: Partial<CodexConfig>;
  review?: Partial<ReviewConfig>;
  pi?: { provider?: Partial<PiProviderConfig> };
  p4?: Record<string, string>;
  tapd?: { backend?: string; access_token?: string; api_user?: string; api_password?: string };
}

export const SETTINGS_PATH = "overrides.yaml";

const PI_PROVIDER_FIELDS = [
  "id", "base_url", "api_key_env", "api_key", "auth_header",
  "model_id", "reasoning", "context_window", "max_tokens",
] as const;
const TAPD_SCALAR_FIELDS = ["backend", "access_token", "api_user", "api_password"] as const;
const CODEX_FIELDS = [
  "model", "reasoning_effort", "approval_policy", "network_access",
  "base_url", "api_key_env", "codex_path", "model_catalog_json",
  "context_window", "auto_compact_token_limit",
] as const;
const REVIEW_FIELDS = ["enabled", "backend", "max_fix_rounds", "model"] as const;

/** 读取 overrides.yaml（不存在或损坏 → null）。 */
export function readSettingsOverrides(path = SETTINGS_PATH): SettingsOverrides | null {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = yaml.load(fs.readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object") return parsed as SettingsOverrides;
  } catch {
    // 损坏则忽略
  }
  return null;
}

/** 把 ov 字段级合并进 target（可变对象）。null/undefined/空串字段跳过，保留原值。 */
function mergeSettingsInto(target: Record<string, unknown>, ov: SettingsOverrides): void {
  if (ov.agent?.backend) {
    const cur = (target.agent ??= {}) as Record<string, unknown>;
    cur.backend = ov.agent.backend;
  }
  if (ov.codex) {
    const cur = (target.codex ??= {}) as Record<string, unknown>;
    for (const k of CODEX_FIELDS) {
      const v = (ov.codex as Record<string, unknown>)[k];
      if (v === undefined || v === null || v === "") continue;
      cur[k] = v;
    }
  }
  if (ov.review) {
    const cur = (target.review ??= {}) as Record<string, unknown>;
    for (const k of REVIEW_FIELDS) {
      const v = (ov.review as Record<string, unknown>)[k];
      if (v === undefined || v === null || (v === "" && k !== "backend")) continue;
      cur[k] = v;
    }
  }
  if (ov.pi?.provider) {
    const cur = (target.pi ??= {}) as Record<string, unknown>;
    const prov = (cur.provider ??= {}) as Record<string, unknown>;
    for (const k of PI_PROVIDER_FIELDS) {
      const v = (ov.pi.provider as Record<string, unknown>)[k];
      if (v === undefined || v === null || v === "") continue;
      prov[k] = v;
    }
  }
  if (ov.p4) {
    const cur = (target.p4 ??= {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(ov.p4)) {
      if (v === undefined || v === null || v === "") continue;
      cur[k] = v;
    }
  }
  if (ov.tapd) {
    const cur = (target.tapd ??= {}) as Record<string, unknown>;
    for (const k of TAPD_SCALAR_FIELDS) {
      const v = (ov.tapd as Record<string, unknown>)[k];
      if (v === undefined || v === null || v === "") continue;
      cur[k] = v;
    }
  }
}

/** 把设置合并进运行中的 Config（不落盘；web POST 用，worker/agent 共用同一 config 引用即实时生效）。 */
export function applySettingsOverrides(cfg: Config, ov: SettingsOverrides | null): void {
  if (!ov) return;
  mergeSettingsInto({
    agent: cfg.agent,
    codex: cfg.codex,
    review: cfg.review,
    pi: cfg.pi,
    p4: cfg.p4,
    tapd: cfg.tapd,
  }, ov);
}

/** 把设置合并写回 overrides.yaml（保留已有其它项；下次启动 loadConfig 自动读回）。 */
export function saveSettingsOverrides(ov: SettingsOverrides, path = SETTINGS_PATH): void {
  const raw = (readSettingsOverrides(path) ?? {}) as unknown as Record<string, unknown>;
  mergeSettingsInto(raw, ov);
  fs.writeFileSync(path, yaml.dump(raw));
}

export interface Config {
  max_bugs_per_run: number;
  max_attempts: number;
  agent_timeout_s: number;
  agent: AgentSelectionConfig;
  codex: CodexConfig;
  mcp_servers: McpServersConfig;
  quality: QualityConfig;
  review: ReviewConfig;
  exclude_status: string[];
  priority_weight: Record<string, number>;
  workspaces: WorkspaceConfig[];
  pi: PiConfig;
  p4: Record<string, string>;
  web: Record<string, string | number>;
  tapd: Record<string, unknown>;
  config_path: string;
}

/** 优先级 -> 排序权重，数字越小越优先；未知值排最后。 */
export function priorityRank(cfg: Config, bug: { priority: string; priority_label: string }): number {
  const w = cfg.priority_weight;
  for (const key of [bug.priority, bug.priority_label, String(bug.priority)]) {
    if (key in w) return w[key];
  }
  return Math.max(0, ...Object.values(w)) + 1;
}

export function webToken(cfg: Config): string {
  return process.env.WEB_TOKEN ?? String(cfg.web.token ?? "") ?? "";
}

export function repoByName(cfg: Config, name: string): RepoConfig | undefined {
  for (const ws of cfg.workspaces) {
    const r = ws.repos.find((r) => r.name === name);
    if (r) return r;
  }
  return undefined;
}

/** 极简 .env 解析（KEY=VALUE，'#' 注释，支持引号），写入 process.env（已存在的优先）。 */
export function loadEnvFile(envPath?: string): void {
  const p = envPath ?? ".env";
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) process.env[key] ??= value;
  }
}

function buildRepos(data: unknown): RepoConfig[] {
  const repos: RepoConfig[] = [];
  for (const item of Array.isArray(data) ? data : []) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const verifyCmds = Array.isArray(d.verify_cmds)
      ? d.verify_cmds.map(String).map((v) => v.trim()).filter(Boolean)
      : [];
    const ignorePaths = Array.isArray(d.ignore_paths)
      ? d.ignore_paths.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    const preflightReconcile = String(d.preflight_reconcile ?? "never").trim().toLowerCase();
    repos.push({
      name: String(d.name ?? ""),
      path: String(d.path ?? ""),
      verify_cmds: verifyCmds,
      ignore_paths: ignorePaths,
      preflight_reconcile: preflightReconcile as RepoConfig["preflight_reconcile"],
      additional_dirs: buildAdditionalDirs(d.additional_dirs),
    });
  }
  return repos;
}

function buildAdditionalDirs(data: unknown): AdditionalDirConfig[] {
  const dirs: AdditionalDirConfig[] = [];
  for (const item of Array.isArray(data) ? data : []) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const verifyCmds = Array.isArray(d.verify_cmds)
      ? d.verify_cmds.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    const ignorePaths = Array.isArray(d.ignore_paths)
      ? d.ignore_paths.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    dirs.push({
      name: String(d.name ?? ""),
      path: String(d.path ?? ""),
      vcs: String(d.vcs ?? "git").toLowerCase() as "git",
      base_branch: String(d.base_branch ?? ""),
      author: String(d.author ?? ""),
      verify_cmds: verifyCmds,
      ignore_paths: ignorePaths,
    });
  }
  return dirs;
}

function assertNoLegacyConfig(raw: Record<string, unknown>): void {
  const unsupported: string[] = [];
  if ("mode" in raw) unsupported.push("mode");
  if ("llm_review" in raw) unsupported.push("llm_review");
  if ("poll_interval_min" in raw) unsupported.push("poll_interval_min");
  const quality = raw.quality && typeof raw.quality === "object"
    ? raw.quality as Record<string, unknown>
    : {};
  if ("investigation_enabled" in quality) unsupported.push("quality.investigation_enabled");
  const pi = raw.pi && typeof raw.pi === "object" ? raw.pi as Record<string, unknown> : {};
  if ("model" in pi) unsupported.push("pi.model");
  for (const [workspaceIndex, workspace] of (Array.isArray(raw.workspaces) ? raw.workspaces : []).entries()) {
    if (!workspace || typeof workspace !== "object") continue;
    const data = workspace as Record<string, unknown>;
    if ("comment_status" in data) unsupported.push(`workspaces[${workspaceIndex}].comment_status`);
    for (const [repoIndex, repo] of (Array.isArray(data.repos) ? data.repos : []).entries()) {
      if (repo && typeof repo === "object" && "test_cmd" in repo) {
        unsupported.push(`workspaces[${workspaceIndex}].repos[${repoIndex}].test_cmd`);
      }
    }
  }
  if (unsupported.length) {
    throw new Error(`不再支持的配置字段: ${unsupported.join(", ")}；请直接改用当前 config.example.yaml`);
  }
}

export function loadConfig(configPath?: string, envFile?: string, settingsPath = SETTINGS_PATH): Config {
  loadEnvFile(envFile);

  const cfg: Config = {
    max_bugs_per_run: 10,
    max_attempts: 2,
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
        min_score: 55,
        require_reproduction_signal: true,
        manual_keywords: [],
        high_risk_keywords: ["支付", "账号", "登录", "鉴权", "存档", "协议", "加密", "隐私"],
      },
      require_verification: true,
      max_changed_files: 8,
      max_diff_lines: 500,
    },
    review: { enabled: true, backend: "", max_fix_rounds: 1, model: "" },
    exclude_status: [...DEFAULT_EXCLUDE_STATUS],
    priority_weight: { ...DEFAULT_PRIORITY_WEIGHT },
    workspaces: [],
    pi: { provider: undefined },
    p4: {},
    web: { host: "127.0.0.1", port: 8080, token: "" },
    tapd: {},
    config_path: "",
  };

  const p = configPath ?? "config.yaml";
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    cfg.config_path = path.resolve(p);
    const parsed = yaml.load(fs.readFileSync(p, "utf-8"));
    raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    assertNoLegacyConfig(raw);
  }

  cfg.max_bugs_per_run = Number(raw.max_bugs_per_run ?? cfg.max_bugs_per_run);
  cfg.max_attempts = Number(raw.max_attempts ?? cfg.max_attempts);
  cfg.agent_timeout_s = Number(raw.agent_timeout_s ?? cfg.agent_timeout_s);

  const agentRaw = (raw.agent ?? {}) as Record<string, unknown>;
  cfg.agent.backend = String(agentRaw.backend ?? cfg.agent.backend) as AgentBackend;

  const codexRaw = (raw.codex ?? {}) as Record<string, unknown>;
  cfg.codex.model = String(codexRaw.model ?? cfg.codex.model);
  cfg.codex.reasoning_effort = String(
    codexRaw.reasoning_effort ?? cfg.codex.reasoning_effort,
  ) as CodexConfig["reasoning_effort"];
  cfg.codex.approval_policy = String(
    codexRaw.approval_policy ?? cfg.codex.approval_policy,
  ) as CodexConfig["approval_policy"];
  cfg.codex.network_access = Boolean(codexRaw.network_access ?? cfg.codex.network_access);
  cfg.codex.base_url = String(codexRaw.base_url ?? cfg.codex.base_url);
  cfg.codex.api_key_env = String(codexRaw.api_key_env ?? cfg.codex.api_key_env);
  cfg.codex.codex_path = String(codexRaw.codex_path ?? cfg.codex.codex_path);
  cfg.codex.model_catalog_json = String(
    codexRaw.model_catalog_json ?? cfg.codex.model_catalog_json,
  );
  cfg.codex.context_window = Number(codexRaw.context_window ?? cfg.codex.context_window);
  cfg.codex.auto_compact_token_limit = Number(
    codexRaw.auto_compact_token_limit ?? cfg.codex.auto_compact_token_limit,
  );

  cfg.mcp_servers = parseMcpServers(raw.mcp_servers);

  const qualityRaw = (raw.quality ?? {}) as Record<string, unknown>;
  const admissionRaw = (qualityRaw.admission ?? {}) as Record<string, unknown>;
  cfg.quality.require_verification = Boolean(
    qualityRaw.require_verification ?? cfg.quality.require_verification,
  );
  cfg.quality.max_changed_files = Number(
    qualityRaw.max_changed_files ?? cfg.quality.max_changed_files,
  );
  cfg.quality.max_diff_lines = Number(qualityRaw.max_diff_lines ?? cfg.quality.max_diff_lines);
  cfg.quality.admission.min_score = Number(
    admissionRaw.min_score ?? cfg.quality.admission.min_score,
  );
  cfg.quality.admission.require_reproduction_signal = Boolean(
    admissionRaw.require_reproduction_signal ?? cfg.quality.admission.require_reproduction_signal,
  );
  if (Array.isArray(admissionRaw.manual_keywords)) {
    cfg.quality.admission.manual_keywords = admissionRaw.manual_keywords.map(String).filter(Boolean);
  }
  if (Array.isArray(admissionRaw.high_risk_keywords)) {
    cfg.quality.admission.high_risk_keywords = admissionRaw.high_risk_keywords.map(String).filter(Boolean);
  }

  const reviewRaw = (raw.review ?? {}) as Record<string, unknown>;
  cfg.review.enabled = Boolean(reviewRaw.enabled ?? cfg.review.enabled);
  cfg.review.backend = String(
    reviewRaw.backend ?? cfg.review.backend,
  ) as ReviewConfig["backend"];
  cfg.review.max_fix_rounds = Math.max(0, Number(
    reviewRaw.max_fix_rounds ?? cfg.review.max_fix_rounds,
  ));
  cfg.review.model = String(reviewRaw.model ?? cfg.review.model);

  const filters = (raw.filters ?? {}) as Record<string, unknown>;
  if (Array.isArray(filters.exclude_status)) {
    cfg.exclude_status = filters.exclude_status.map(String);
  }
  if (raw.priority_weight && typeof raw.priority_weight === "object") {
    const w = raw.priority_weight as Record<string, unknown>;
    cfg.priority_weight = {};
    for (const [k, v] of Object.entries(w)) cfg.priority_weight[k] = Number(v);
  }

  cfg.workspaces = [];
  for (const ws of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
    if (!ws || typeof ws !== "object") continue;
    const w = ws as Record<string, unknown>;
    cfg.workspaces.push({
      workspace_id: String(w.workspace_id ?? ""),
      owner: String(w.owner ?? ""),
      repos: buildRepos(w.repos),
      default_repo: String(w.default_repo ?? ""),
    });
  }

  const piRaw = (raw.pi ?? {}) as Record<string, unknown>;
  cfg.pi = { provider: undefined };
  const pvRaw = (piRaw.provider ?? {}) as Record<string, unknown>;
  if (pvRaw && typeof pvRaw === "object" && Object.keys(pvRaw).length) {
    const numOrUndef = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
    const strOrUndef = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
    const boolOrUndef = (v: unknown) => (v === undefined || v === null ? undefined : Boolean(v));
    cfg.pi.provider = {
      id: String(pvRaw.id ?? ""),
      base_url: strOrUndef(pvRaw.base_url),
      api_key_env: strOrUndef(pvRaw.api_key_env),
      api_key: strOrUndef(pvRaw.api_key),
      auth_header: boolOrUndef(pvRaw.auth_header),
      model_id: strOrUndef(pvRaw.model_id),
      reasoning: boolOrUndef(pvRaw.reasoning),
      context_window: numOrUndef(pvRaw.context_window),
      max_tokens: numOrUndef(pvRaw.max_tokens),
    };
  }
  if (Array.isArray(piRaw.skill_dirs)) {
    const dirs = piRaw.skill_dirs.map(String).filter((s) => s.trim());
    if (dirs.length) cfg.pi.skill_dirs = dirs;
  }

  cfg.p4 = (raw.p4 ?? {}) as Record<string, string>;
  cfg.web = (raw.web ?? { host: "127.0.0.1", port: 8080, token: "" }) as Record<string, string | number>;
  cfg.tapd = (raw.tapd ?? {}) as Record<string, unknown>;

  // ---- 环境变量覆盖（密钥优先放 .env）----
  const tapd = cfg.tapd as Record<string, unknown>;
  tapd.backend = process.env.TAPD_BACKEND ?? tapd.backend ?? "rest";
  tapd.api_user = process.env.TAPD_API_USER ?? tapd.api_user ?? "";
  tapd.api_password = process.env.TAPD_API_PASSWORD ?? tapd.api_password ?? "";
  tapd.access_token = process.env.TAPD_ACCESS_TOKEN ?? tapd.access_token ?? "";
  const mcp = { ...((tapd.mcp ?? {}) as Record<string, unknown>) };
  if (!mcp.transport) mcp.transport = process.env.MCP_TRANSPORT ?? "streamable-http";
  if (!mcp.url) mcp.url = process.env.MCP_URL ?? "";
  if (!mcp.token) mcp.token = process.env.MCP_TOKEN ?? "";
  if (!mcp.access_token) mcp.access_token = tapd.access_token;
  tapd.mcp = mcp;

  cfg.p4.port = process.env.P4PORT ?? cfg.p4.port ?? "";
  cfg.p4.client = process.env.P4CLIENT ?? cfg.p4.client ?? "";
  cfg.p4.user = process.env.P4USER ?? cfg.p4.user ?? "";
  cfg.p4.password = process.env.P4PASSWD ?? cfg.p4.password ?? "";
  cfg.p4.ignore = process.env.P4IGNORE ?? cfg.p4.ignore ?? "";

  // Web 设置页的 overrides.yaml 最后应用（优先级最高，覆盖 config.yaml 与 .env）
  applySettingsOverrides(cfg, readSettingsOverrides(settingsPath));

  return cfg;
}

function isPlaceholder(value: unknown): boolean {
  const v = String(value ?? "").toLowerCase();
  if (!v) return true;
  return ["your", "example", "<", "todo", "xxx", "placeholder"].some((p) => v.includes(p));
}

/** 返回配置问题列表（空表示 OK）。 */
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
  const agentBackend = cfg.agent?.backend ?? "pi";
  if (agentBackend !== "pi" && agentBackend !== "codex") {
    problems.push(`agent.backend 必须是 pi 或 codex（当前: ${agentBackend}）`);
  }
  if (cfg.review.backend && cfg.review.backend !== "pi" && cfg.review.backend !== "codex") {
    problems.push(`review.backend 必须为空、pi 或 codex（当前: ${cfg.review.backend}）`);
  }
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(cfg.codex.reasoning_effort)) {
    problems.push(`codex.reasoning_effort 无效（当前: ${cfg.codex.reasoning_effort}）`);
  }
  if (!["never", "on-request", "on-failure", "untrusted"].includes(cfg.codex.approval_policy)) {
    problems.push(`codex.approval_policy 无效（当前: ${cfg.codex.approval_policy}）`);
  }
  if (cfg.codex.context_window < 0 || !Number.isFinite(cfg.codex.context_window)) {
    problems.push("codex.context_window 必须是非负数");
  }
  if (cfg.codex.auto_compact_token_limit < 0 || !Number.isFinite(cfg.codex.auto_compact_token_limit)) {
    problems.push("codex.auto_compact_token_limit 必须是非负数");
  }
  if (cfg.codex.context_window > 0
      && cfg.codex.auto_compact_token_limit >= cfg.codex.context_window) {
    problems.push("codex.auto_compact_token_limit 必须小于 codex.context_window");
  }
  const tapd = cfg.tapd as Record<string, unknown>;
  const backend = String(tapd.backend ?? "rest");
  if (backend === "mcp") {
    const mcp = (tapd.mcp ?? {}) as Record<string, unknown>;
    if (mcp.transport === "streamable-http" && !mcp.url) {
      problems.push("缺少 Tapd MCP 连接地址（tapd.mcp.url，腾讯云托管 MCP 专属地址）");
    }
    if (!(mcp.access_token ?? tapd.access_token)) {
      problems.push("缺少 TAPD_ACCESS_TOKEN（个人访问令牌，推荐）或 TAPD_API_USER/PASSWORD");
    }
  } else if (!tapd.api_user || !tapd.api_password) {
    problems.push("缺少 Tapd API 凭据（TAPD_API_USER / TAPD_API_PASSWORD 或 config.tapd）");
  }

  for (const key of ["port", "client", "user"] as const) {
    if (isPlaceholder(cfg.p4[key])) {
      problems.push(`p4.${key} 未配置（当前: ${JSON.stringify(cfg.p4[key])}），Agent 无法连接 Perforce`);
    }
  }
  if (!cfg.workspaces.length) problems.push("未配置 workspaces");
  for (const ws of cfg.workspaces) {
    if (!ws.workspace_id) problems.push("workspace.workspace_id 为空");
    if (!ws.owner) problems.push(`workspace ${ws.workspace_id} 未配置 owner（current_owner 过滤用）`);
    for (const repo of ws.repos) {
      if (!repo.path || !fs.existsSync(repo.path)) {
        problems.push(`仓库 ${repo.name ?? ""} 路径不存在: ${repo.path}`);
      }
      if (cfg.quality.require_verification && !repo.verify_cmds.length) {
        problems.push(`仓库 ${repo.name ?? ""} 未配置 verify_cmds；候选补丁不会标记为已验证`);
      }
      for (const ignored of repo.ignore_paths ?? []) {
        const normalized = ignored.replace(/\\/g, "/");
        if (path.isAbsolute(ignored) || normalized.split("/").includes("..")) {
          problems.push(`仓库 ${repo.name || "(未命名)"} 的 ignore_paths 必须是仓库内相对路径: ${ignored}`);
        }
      }
      if (!["always", "once", "never"].includes(repo.preflight_reconcile ?? "never")) {
        problems.push(`仓库 ${repo.name || "(未命名)"} 的 preflight_reconcile 只能是 always、once 或 never`);
      }
      const aliases = new Set<string>(["project"]);
      for (const dir of repo.additional_dirs ?? []) {
        const alias = dir.name.trim().toLowerCase();
        if (!alias) problems.push(`仓库 ${repo.name ?? ""} 的 additional_dirs.name 为空`);
        else if (!/^[a-z][a-z0-9_-]*$/i.test(alias)) {
          problems.push(`附加目录别名 ${dir.name} 无效；只能使用字母开头的字母、数字、_、-`);
        } else if (aliases.has(alias)) {
          problems.push(`仓库 ${repo.name ?? ""} 的目录别名重复: ${dir.name}`);
        }
        aliases.add(alias);
        if (dir.vcs !== "git") problems.push(`附加目录 ${dir.name || "(未命名)"} 的 vcs 仅支持 git`);
        if (!dir.path || !fs.existsSync(dir.path)) {
          problems.push(`附加目录 ${dir.name || "(未命名)"} 路径不存在: ${dir.path}`);
        }
        if (!dir.base_branch) problems.push(`附加目录 ${dir.name || "(未命名)"} 未配置 base_branch`);
        for (const ignored of dir.ignore_paths ?? []) {
          const normalized = ignored.replace(/\\/g, "/");
          if (path.isAbsolute(ignored) || normalized.split("/").includes("..")) {
            problems.push(`附加目录 ${dir.name || "(未命名)"} 的 ignore_paths 必须是仓库内相对路径: ${ignored}`);
          }
        }
        if (cfg.quality.require_verification && !dir.verify_cmds.length) {
          problems.push(`附加目录 ${dir.name || "(未命名)"} 未配置 verify_cmds；候选补丁不会标记为已验证`);
        }
      }
    }
  }
  problems.push(...mcpServerConfigProblems(
    cfg.mcp_servers,
    cfg.workspaces.flatMap((workspace) => workspace.repos.map((repo) => repo.path)),
  ));
  if (!cfg.p4.client) problems.push("未配置 P4CLIENT（Agent 专用 p4 workspace）");
  return problems;
}
