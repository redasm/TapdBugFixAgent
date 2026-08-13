/** 配置加载：config.yaml + .env（环境变量优先）。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

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

export interface RepoConfig {
  name: string;
  path: string;
  test_cmd: string;
}

export interface WorkspaceConfig {
  workspace_id: string;
  owner: string;
  repos: RepoConfig[];
  default_repo: string;
  comment_status: string;
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
}

/** Web 设置页可编辑的配置项，持久化到 overrides.yaml（不重写带注释的 config.yaml）。
 *  loadConfig 启动时按"字段级合并"应用，优先级最高（覆盖 config.yaml 与 .env）。
 *  空字符串/undefined 的字段视为"保持不变"，不会被写入或覆盖。 */
export interface SettingsOverrides {
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
  mergeSettingsInto({ pi: cfg.pi, p4: cfg.p4, tapd: cfg.tapd }, ov);
}

/** 把设置合并写回 overrides.yaml（保留已有其它项；下次启动 loadConfig 自动读回）。 */
export function saveSettingsOverrides(ov: SettingsOverrides, path = SETTINGS_PATH): void {
  const raw = (readSettingsOverrides(path) ?? {}) as unknown as Record<string, unknown>;
  mergeSettingsInto(raw, ov);
  fs.writeFileSync(path, yaml.dump(raw));
}

export interface Config {
  mode: string;
  poll_interval_min: number;
  max_bugs_per_run: number;
  max_attempts: number;
  agent_timeout_s: number;
  llm_review: boolean;
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
    repos.push({
      name: String(d.name ?? ""),
      path: String(d.path ?? ""),
      test_cmd: String(d.test_cmd ?? ""),
    });
  }
  return repos;
}

export function loadConfig(configPath?: string, envFile?: string, settingsPath = SETTINGS_PATH): Config {
  loadEnvFile(envFile);

  const cfg: Config = {
    mode: "review",
    poll_interval_min: 30,
    max_bugs_per_run: 10,
    max_attempts: 1,
    agent_timeout_s: 900,
    llm_review: false,
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
  }

  cfg.mode = String(raw.mode ?? cfg.mode);
  cfg.poll_interval_min = Number(raw.poll_interval_min ?? cfg.poll_interval_min);
  cfg.max_bugs_per_run = Number(raw.max_bugs_per_run ?? cfg.max_bugs_per_run);
  cfg.max_attempts = Number(raw.max_attempts ?? cfg.max_attempts);
  cfg.agent_timeout_s = Number(raw.agent_timeout_s ?? cfg.agent_timeout_s);
  cfg.llm_review = Boolean(raw.llm_review ?? cfg.llm_review);

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
      comment_status: String(w.comment_status ?? "resolved"),
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
    }
  }
  if (!cfg.p4.client) problems.push("未配置 P4CLIENT（Agent 专用 p4 workspace）");
  return problems;
}
