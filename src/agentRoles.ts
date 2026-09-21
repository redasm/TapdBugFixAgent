/** 显式角色层：把原先隐式的阶段（调查/实施/评审/恢复）变成可配置、可审计的角色。
 *
 *  职责边界（与 README「工作原理」一致）：
 *  - Orchestrator（worker.ts）只负责状态机、派发与验收：每个阶段把一次独立上下文的调用
 *    派发给 Pi 子进程，然后按 P4 / Git / 验证 / 评审事实验收。
 *  - 子 Agent（Pi 子进程）只负责单一阶段；每次调用都是全新上下文，不共享会话。
 *
 *  拓扑约束（文档约定，非运行时强制）：本工具是「两层编排」——Orchestrator → Pi 子进程。
 *  Pi 子进程没有任何回调本编排器入口（没有把 worker 暴露给 Pi 的工具/MCP/扩展），
 *  因此不存在子调用递归。只读角色（investigation / review）之间的并发是未来边界；
 *  实施、P4/Git 写入与交付必须保持串行，本轮不引入任何并行写入。
 */

import type { Config } from "./config.js";

/** 规范角色名。旧配置里写 investigator/implementer/reviewer 也会归一到这些名字。
 *  顺序即角色层文档表里的顺序；测试会逐字断言（tests/agentRoles.test.ts）。 */
export const AGENT_ROLES = [
  "investigation", "implementation", "review", "recovery", "coordinator",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 兼容别名 → 规范角色名。 */
export const AGENT_ROLE_ALIASES: Record<string, AgentRole> = {
  investigator: "investigation",
  implementer: "implementation",
  reviewer: "review",
};

/** 角色语义（文档与审计用；不改变既有 phase 取值）。
 *  注意：这些字符串会原样出现在进度行与审计里，改动措辞前先看 tests/agentRoles.test.ts 的断言。
 *  审计里的 role（本枚举）与 phase（worker 写入）是两个字段：一个角色可对应多个 phase。
 *  各角色的调用点、读写/工具边界与 timeout_s 例外，见 config.yaml / config.example.yaml 的
 *  agents.roles 段注释（recovery 例外最多：它有意不配 timeout_s，以保留三类调用各自的派生预算）。 */
export const AGENT_ROLE_PURPOSE: Record<AgentRole, string> = {
  // 只读：sandbox 只读 + read/grep/find/ls 白名单；用于主调查、补充核查与范围复核。
  investigation: "只读调查：定位根因、证据与最小修改范围（含补充核查与范围复核）",
  // 唯一写入角色：sandbox workspace-write，必须产生真实落笔（只读超预算会被提前终止）。
  implementation: "实施：按调查计划写入首轮修复",
  // 只读评审：核对真实 diff 与验收证据，只给结论与 findings，修改交给 recovery 执行。
  review: "独立只读评审：核对 diff、验收证据与复用情况",
  // 唯一覆盖三类语义的角色：无工具收尾 / 编码预算收尾 / Reviewer 拒绝后的定向修正（含其再次收尾）；
  // 权限跟随被接管阶段，三类调用预算规则不同，因此角色层默认不配 timeout_s。
  recovery: "恢复/修正：无工具收尾、预算收尾与 Reviewer 拒绝后的定向修正",
  // 只读且无工具（tools: []）。唯一不参与决策的角色：只做「任务规划」与「最终汇总」两件事，
  // 输出仅作为调查附加上下文 / 交付描述文本；文件白名单、阶段推进、P4/Git、验证与评审结论
  // 全部仍由编排器（worker 状态机）决定。失败/超时/非法输出一律降级，绝不影响任务结论；
  // 唯一例外是人工取消必须原样向上抛（见 src/coordinator.ts）。
  coordinator: "任务规划与最终汇总：只读无工具，仅产出文字建议与摘要，不参与任何决策",
};

/** 角色可覆盖的字段。只支持能安全接入到现有调用结构的项：
 *  - model：角色模型覆盖（空 = 沿用 pi.provider 默认模型；裸模型名由 agentRoleModel 补 provider 前缀）
 *  - timeout_s：角色单次调用时限（秒，未配置 = 沿用调用点传入的 fallback：阶段预算或派生上限）
 *  收尾/补查等派生调用额外套用 min(角色时限, 派生上限)，所以配 timeout_s 只能收紧、不会放大收尾预算；
 *  recovery 正因三类调用预算规则不同而默认留空，以保留各自的派生预算。
 *  sandbox / tools 是各阶段的硬约束（只读阶段必须只读），不接受配置放宽。 */
export const AGENT_ROLE_SETTINGS_FIELDS = ["model", "timeout_s"] as const;

/** 两层编排中「子 Agent」这一层的深度：Orchestrator = 0，Pi 子进程 = 1。 */
export const SUB_AGENT_ORCHESTRATION_DEPTH = 1;
/** 两层编排的最大深度（拓扑声明：不提供任何递归派发入口）。 */
export const ORCHESTRATION_MAX_DEPTH = 2;

export interface AgentRoleSettings {
  /** 角色模型覆盖；空/未配置 = 沿用 pi.provider 默认模型（读取统一走 agentRoleModel）。 */
  model?: string;
  /** 角色单次调用时限（秒）；未配置 = 沿用调用点给出的 fallback（见 agentRoleTimeoutS）。
   *  派生调用（收尾/补查）还会被 min(角色时限, 派生上限) 再收紧，见 agentRoleTimeoutS 注释。 */
  timeout_s?: number;
}

export interface AgentsConfig {
  /** 角色覆盖项；config.yaml 没有 agents 段时为空对象 = 行为与改造前完全一致。 */
  roles: Partial<Record<AgentRole, AgentRoleSettings>>;
  /** 配置问题（未知角色名 / 条目类型错误 / 不支持的字段或非法取值）；
   *  仅用于启动与设置页提示，不影响运行。 */
  problems: string[];
}

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

/** 角色名归一：支持规范名与 investigator/implementer/reviewer 别名（大小写不敏感）。 */
export function normalizeAgentRoleName(name: string): AgentRole | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  if (isAgentRole(key)) return key;
  return AGENT_ROLE_ALIASES[key];
}

/** 解析 config.yaml 的 agents 段。缺省、类型不符或条目损坏一律回落（不抛错），
 *  保证旧 config.yaml（完全没有 agents）解析结果为空覆盖、行为不变。 */
export function parseAgentsConfig(raw: unknown): AgentsConfig {
  const out: AgentsConfig = { roles: {}, problems: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const rolesRaw = (raw as Record<string, unknown>).roles;
  if (rolesRaw === undefined || rolesRaw === null) return out;
  if (typeof rolesRaw !== "object" || Array.isArray(rolesRaw)) {
    out.problems.push("agents.roles 必须是「角色名: 配置」映射；当前已忽略");
    return out;
  }
  for (const [name, value] of Object.entries(rolesRaw as Record<string, unknown>)) {
    const role = normalizeAgentRoleName(name);
    if (!role) {
      out.problems.push(
        `agents.roles.${name} 不是受支持的角色（可用: ${AGENT_ROLES.join(", ")}；`
        + `别名: ${Object.keys(AGENT_ROLE_ALIASES).join(", ")}）`,
      );
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      out.problems.push(`agents.roles.${name} 必须是映射（model / timeout_s），当前已忽略`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const settings: AgentRoleSettings = {};
    // 显式写了 model（哪怕留空）也算一次有效配置：空串 = 沿用 pi.provider 默认模型。
    // 保留这个条目是必要的——coordinator 的启用判定读的就是「角色条目是否存在」，
    // 而示例配置正是用 `model: ''` 这种写法启用它（空值本身不改变模型选择）。
    if (entry.model !== undefined && entry.model !== null) {
      const model = String(entry.model).trim();
      settings.model = model;
    }
    const hasTimeout = entry.timeout_s !== undefined && entry.timeout_s !== null
      && String(entry.timeout_s).trim() !== "";
    if (hasTimeout) {
      const timeout = Number(entry.timeout_s);
      if (Number.isFinite(timeout) && timeout > 0) settings.timeout_s = timeout;
      else out.problems.push(`agents.roles.${name}.timeout_s 必须是正数（秒）: ${String(entry.timeout_s)}`);
    }
    for (const key of Object.keys(entry)) {
      if (!(AGENT_ROLE_SETTINGS_FIELDS as readonly string[]).includes(key)) {
        out.problems.push(`agents.roles.${name}.${key} 不受支持（仅支持 ${AGENT_ROLE_SETTINGS_FIELDS.join(", ")}）`);
      }
    }
    // 只有确实解析出有效配置才记录条目：全非法/空对象的角色不产生任何行为差异
    // （示例配置里的注释形态 `coordinator:  # model: ...` 会解析成空对象，必须保持不启用）。
    if (settings.model !== undefined || settings.timeout_s !== undefined) out.roles[role] = settings;
  }
  return out;
}

/** 读取角色覆盖项；未配置（含旧 Config 对象没有 agents）时返回 undefined。 */
export function agentRoleSettings(cfg: Config, role: AgentRole): AgentRoleSettings | undefined {
  return cfg.agents?.roles?.[role];
}

/** 该角色是否被显式启用（配置里出现了 `agents.roles.<role>` 且解析出至少一个有效字段）。
 *
 *  只用于 coordinator：它是本次改造新增的调用点（会在既有调用序列里插入两次只读调用），
 *  因此必须**显式配置**才生效——没写 `agents.roles.coordinator` 时行为与改造前逐字一致，
 *  既不影响既有用例的调用计数，也不会在用户没要求时额外消耗两次模型调用。
 *  其余角色一直存在，缺省即「不覆盖」，不经过这个判定。
 *
 *  注意口径：`agents.roles` 里写过但**没有任何有效字段**的条目会被 parseAgentsConfig 丢弃
 *  （沿用既有规则：空值不产生行为差异），因此这里判断的是「配置有效」，不是「出现过这个键」。
 *  想让 coordinator 生效请写 `model:`（留空即用 pi.provider 默认模型）或 `timeout_s:`。 */
export function agentRoleEnabled(cfg: Config, role: AgentRole): boolean {
  return Boolean(cfg.agents?.roles?.[role]);
}

/** 角色模型：空字符串 = 未配置（沿用 pi.provider 默认模型）。
 *  只写裸模型名时自动补 provider 前缀；全部角色（含 review）共用这一套语义。 */
export function agentRoleModel(cfg: Config, role: AgentRole): string {
  const configured = agentRoleSettings(cfg, role)?.model?.trim() ?? "";
  if (!configured) return "";
  if (configured.includes("/")) return configured;
  const providerId = cfg.pi?.provider ? (cfg.pi.provider.id?.trim() || "gateway") : "";
  return providerId ? `${providerId}/${configured}` : configured;
}

/** 角色时限：配置了 agents.roles.<role>.timeout_s 就用它，否则沿用调用点现有的阶段预算。
 *  fallback 由调用点决定：
 *  - 主调用（主调查 / 首轮实施 / 评审 / Reviewer 定向修正）传该阶段原有预算；
 *  - 收尾/补查等派生调用传派生上限，并由调用点再取 min(...) 封顶，因此角色时限只收紧、不放宽。
 *  recovery 是唯一涉及两种规则的调用点，这也是它的 timeout_s 默认留空的原因：
 *  同一个值会同时套到「收尾（受派生上限约束）」与「Reviewer 定向修正（需要完整预算）」两处。 */
export function agentRoleTimeoutS(cfg: Config, role: AgentRole, fallback: number): number {
  const configured = agentRoleSettings(cfg, role)?.timeout_s;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : fallback;
}

/** 角色覆盖快照（写入尝试审计元数据，便于事后核对本次用了模型/时限、以及哪些角色被显式配置过）。
 *  `model: ""` 会原样保留：它表示「该角色被显式启用但沿用 pi.provider 默认模型」，
 *  与「角色压根没配置」是两种状态（coordinator 的启用判定就依赖这个区别），审计里必须能分辨。 */
export function agentRoleSnapshot(cfg: Config): Record<string, AgentRoleSettings> {
  const out: Record<string, AgentRoleSettings> = {};
  for (const role of AGENT_ROLES) {
    const settings = agentRoleSettings(cfg, role);
    if (!settings) continue;
    out[role] = {
      ...(settings.model !== undefined ? { model: agentRoleModel(cfg, role) } : {}),
      ...(settings.timeout_s ? { timeout_s: settings.timeout_s } : {}),
    };
  }
  return out;
}

/** 角色模型里「属于某个 provider」的模型 id 集合（供 pi models.json 注册时动态收集）。
 *
 *  判定规则（与 agentRoleModel 的补前缀语义一致）：
 *  - `provider/model`：只有 provider 段与目标 provider 同名（大小写不敏感）才算属于它；
 *    别的 provider 的模型**绝不**被注册进本 provider（跨 provider 不误注册）。
 *  - 裸模型名（不含 "/"）：由 agentRoleModel 自动补**目标 provider** 前缀，因此归属于它。
 *  - 重复模型只保留首次出现的顺序，保证 models.json 稳定可比对。 */
export function roleModelIdsForProvider(
  providerId: string,
  models: Array<string | undefined>,
): string[] {
  const target = providerId.trim().toLowerCase();
  const out: string[] = [];
  for (const raw of models) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const separator = text.indexOf("/");
    let modelId = text;
    if (separator >= 0) {
      // 带 provider 前缀却指向别的 provider：属于对方，不能注册到本 provider。
      if (text.slice(0, separator).trim().toLowerCase() !== target) continue;
      modelId = text.slice(separator + 1).trim();
    }
    if (!modelId || out.includes(modelId)) continue;
    out.push(modelId);
  }
  return out;
}

/** 配置里所有角色模型（已补 provider 前缀的解析结果），供 provider 注册收集。
 *  跳过空模型：空 = 沿用 pi.provider 默认模型，不产生额外注册项。 */
export function configuredRoleModels(cfg: Config | undefined): string[] {
  if (!cfg) return [];
  const out: string[] = [];
  for (const role of AGENT_ROLES) {
    const model = agentRoleModel(cfg, role);
    if (model) out.push(model);
  }
  return out;
}

/** 本 provider 实际会注册进 models.json 的模型 id（与 ensurePiModels 的收集口径逐字一致：
 *  pi.provider.model_id 在前，其后是归属本 provider 的角色模型，去重、保持顺序）。 */
export function piProviderModelIds(cfg: Config): string[] {
  const providerId = cfg.pi?.provider?.id?.trim() || "gateway";
  const defaultModelId = (cfg.pi?.provider?.model_id ?? "").trim();
  return [...new Set([
    defaultModelId.includes("/") ? defaultModelId.slice(defaultModelId.lastIndexOf("/") + 1).trim() : defaultModelId,
    ...roleModelIdsForProvider(providerId, configuredRoleModels(cfg)),
  ].filter(Boolean))];
}

/** 配置告警：provider 已配置却注册不出任何模型时返回可直接展示的提示（否则 null）。
 *  与 validateConfig 的其它问题同格式；只提示不阻断——provider 仍按 base_url/api_key 注册。
 *  放在角色层是为了避免 config.ts ←→ agent.ts 的运行时循环依赖（两个模块都要用这条判定）。 */
export function piProviderModelsProblem(cfg: Config): string | null {
  const provider = cfg.pi?.provider;
  if (!provider?.base_url) return null;
  if (piProviderModelIds(cfg).length) return null;
  const providerId = provider.id?.trim() || "gateway";
  return `pi.provider（id=${providerId}）配置了 base_url，但没有 model_id，`
    + "也没有任何 agents.roles.<role>.model 属于该 provider：provider 会被注册但没有可用模型，"
    + "请补 model_id，或给角色配 agents.roles.<role>.model（裸模型名会自动补本 provider 前缀）";
}
