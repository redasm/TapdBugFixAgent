/** Explicit business expectations, independent of the proposed implementation. */
export interface RepairContract {
  acceptance_cases: Array<{ given: string; when: string; then: string; source_refs: string[] }>;
  preserved_behaviors: string[];
  domain_facts: Array<{ concept: string; meaning: string; source_refs: string[] }>;
  reuse_options: Array<{ symbol: string; action: "reuse" | "extract" | "not_applicable"; reason: string }>;
  open_questions: string[];
}

/** 允许作为 source_refs 的工单字段（与 buildBugContext 的键一一对应）。 */
export const BUG_SOURCE_FIELDS = ["title", "description", "expected_result", "reproduction_steps"] as const;

export const CONTRACT_EXAMPLE: RepairContract = {
  acceptance_cases: [{ given: "具体初始状态", when: "触发操作", then: "可观测的业务结果", source_refs: ["bug:title", "evidence:0"] }],
  preserved_behaviors: ["正常对照场景必须保持的行为"],
  domain_facts: [{ concept: "关键 ID/配置/状态", meaning: "其业务含义及与相近概念的区别", source_refs: ["evidence:0"] }],
  reuse_options: [{ symbol: "核查过的相关接口", action: "reuse", reason: "为何可复用；无可用接口则 not_applicable 并说明搜索依据" }],
  open_questions: [],
};

const obj = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const text = (x: unknown): string => typeof x === "string" ? x.trim() : "";
const strings = (x: unknown): string[] => Array.isArray(x) ? x.map(text).filter(Boolean) : [];

// ---------------------------------------------------------------------------
// 验证限制 vs 业务问题
// ---------------------------------------------------------------------------
/** 「执行/验证能力受限」的表述（无法运行游戏、无法启动编辑器、无自动化环境…）。
 *  只有同时满足三件事才算**纯**验证限制：
 *    1) 限制词 + 执行动作 + 执行对象；
 *    2) 不包含业务不确定性（问号/是否/应该/口径/含义/哪个）——这类是业务问题，必须阻断；
 *    3) 不包含代码证据缺口（未证实/未读取/调用链…）——这类必须继续走证据补查。
 *  这样「无法运行游戏验证」不会阻断，而「无法在游戏内验证地图ID应取哪个字段」仍然是业务问题。 */
const LIMITATION_MARKER = /(?:无法|不能|不可|未能|未|没有|缺少|不具备|不支持|受限)/;
const LIMITATION_ACTION = /(?:运行|启动|执行|复现|验证|测试|复测|回归|操作|截图|录屏|连接|构建|编译)/;
const LIMITATION_TARGET = /(?:游戏|客户端|真机|编辑器|模拟器|运行时|自动化|行为测试|端到端|e2e|ui\s*测试|环境|mcp|bridge)/i;
const BUSINESS_UNCERTAINTY = /[?？]|是否|应该|口径|含义|哪个|哪一个|期望(?:行为|结果)|为(?:了)?什么/;
const EVIDENCE_GAP = /未证实|未经证实|未读取|未核对|证据不足|缺少证据|未定位|无法定位|未找到相关|未确认调用|未验证调用/;

export function isVerificationLimitation(value: string): boolean {
  const normalized = String(value ?? "").replace(/\s+/g, "");
  if (!normalized) return false;
  if (BUSINESS_UNCERTAINTY.test(normalized) || EVIDENCE_GAP.test(normalized)) return false;
  return LIMITATION_MARKER.test(normalized)
    && LIMITATION_ACTION.test(normalized)
    && LIMITATION_TARGET.test(normalized);
}

// ---------------------------------------------------------------------------
// source_refs 精确校验
// ---------------------------------------------------------------------------
const refError = (ref: string, evidence: string[], bugFields?: Record<string, unknown>): string => {
  if (ref.startsWith("bug:")) {
    const field = ref.slice(4);
    if (!(BUG_SOURCE_FIELDS as readonly string[]).includes(field)) {
      return `不存在的工单字段（只允许 ${BUG_SOURCE_FIELDS.map((name) => `bug:${name}`).join("、")}）`;
    }
    if (bugFields !== undefined && !text(bugFields[field])) return `工单字段 bug:${field} 为空，不能作为业务证据`;
    return "";
  }
  const match = /^evidence:(\d+)$/.exec(ref);
  if (!match) {
    return "格式非法（只允许 bug:title/description/expected_result/reproduction_steps 或 evidence:N，N 为从 0 起的整数）";
  }
  const index = Number(match[1]);
  const item = evidence[index];
  if (!item) {
    return evidence.length
      ? `序号越界（本次 evidence 只有 ${evidence.length} 项，合法序号 0-${evidence.length - 1}）`
      : "序号越界（本次没有任何 evidence 条目）";
  }
  if (!item.startsWith("[观察]")) {
    const marker = item.match(/^\[[^\]]*\]/)?.[0] ?? "无 [观察]/[推断]/[排除] 标记";
    return `指向的不是 [观察] 项（evidence:${index} 是「${marker}」）`;
  }
  return "";
};

export interface RepairContractParse {
  contract: RepairContract;
  errors: string[];
  /** 真正影响修复方向的业务问题：非空表示本轮不能作为可修复结论（阻断，转人工补充）。 */
  open_questions: string[];
  /** 从 open_questions 迁移出的验证限制：只记录“没能执行哪些验证”，不阻断、也不能写成已通过。 */
  verification_limitations: string[];
}

export function parseRepairContract(
  value: unknown,
  evidence: string[],
  bugFields?: Record<string, unknown>,
): RepairContractParse {
  const raw = obj(value);
  const list = (key: string) => Array.isArray(raw[key]) ? raw[key] as unknown[] : [];
  const errors: string[] = [];
  const refs = (value: unknown, owner: string): string[] => {
    const items = strings(value);
    if (!items.length) {
      errors.push(`${owner} 缺少 source_refs：必须引用工单字段或存在的 [观察] evidence:N`);
      return items;
    }
    for (const ref of items) {
      const reason = refError(ref, evidence, bugFields);
      if (reason) errors.push(`${owner} 的 source_refs 无效: ${ref} — ${reason}`);
    }
    return items;
  };
  const acceptanceCases = list("acceptance_cases").map((x, index) => {
    const r = obj(x);
    return {
      given: text(r.given), when: text(r.when), then: text(r.then),
      source_refs: refs(r.source_refs, `acceptance_cases[${index}]`),
    };
  });
  const domainFacts = list("domain_facts").map((x, index) => {
    const r = obj(x);
    return { concept: text(r.concept), meaning: text(r.meaning), source_refs: refs(r.source_refs, `domain_facts[${index}]`) };
  });
  const rawQuestions = strings(raw.open_questions);
  // 迁移：open_questions 里的纯验证限制不属于业务未决问题，单独记录，绝不阻断修复。
  const verificationLimitations = rawQuestions.filter(isVerificationLimitation);
  const openQuestions = rawQuestions.filter((question) => !isVerificationLimitation(question));
  const contract: RepairContract = {
    acceptance_cases: acceptanceCases,
    preserved_behaviors: strings(raw.preserved_behaviors),
    domain_facts: domainFacts,
    reuse_options: list("reuse_options").map((x) => { const r = obj(x); return { symbol: text(r.symbol), action: text(r.action) as "reuse", reason: text(r.reason) }; }),
    open_questions: openQuestions,
  };
  if (!contract.acceptance_cases.length || contract.acceptance_cases.some(c => !c.given || !c.when || !c.then)) errors.push("缺少完整业务验收条件 given/when/then");
  if (!contract.preserved_behaviors.length) errors.push("缺少正常对照/必须保持的行为");
  if (!contract.domain_facts.length || contract.domain_facts.some(f => !f.concept || !f.meaning)) errors.push("缺少关键业务概念及含义");
  if (!contract.reuse_options.length || contract.reuse_options.some(r => !r.symbol || !r.reason || !["reuse", "extract", "not_applicable"].includes(r.action))) errors.push("缺少经过核查的接口复用方案");
  if (!Array.isArray(raw.open_questions)) errors.push("缺少 open_questions 数组");
  // 刻意不把 open_questions 写进 errors：业务未决问题走 blocked/needs_info 人工出口，
  // 不能混进「格式不完整」的自动重试，也不消耗修复尝试次数。
  return {
    contract,
    errors: [...new Set(errors)],
    open_questions: openQuestions,
    verification_limitations: verificationLimitations,
  };
}

export function formatRepairContract(contract: RepairContract): string {
  return JSON.stringify(contract, null, 2);
}
