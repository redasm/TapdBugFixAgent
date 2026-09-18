/** Explicit business expectations, independent of the proposed implementation. */
export interface RepairContract {
  acceptance_cases: Array<{ given: string; when: string; then: string; source_refs: string[] }>;
  preserved_behaviors: string[];
  domain_facts: Array<{ concept: string; meaning: string; source_refs: string[] }>;
  reuse_options: Array<{ symbol: string; action: "reuse" | "extract" | "not_applicable"; reason: string }>;
  open_questions: string[];
}

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

export function parseRepairContract(value: unknown, evidence: string[], bugFields?: Record<string, unknown>): { contract: RepairContract; errors: string[] } {
  const raw = obj(value);
  const list = (key: string) => Array.isArray(raw[key]) ? raw[key] as unknown[] : [];
  const errors: string[] = [];
  const refs = (value: unknown) => {
    const items = strings(value);
    if (!items.length || items.some(ref => {
      if (["bug:title", "bug:description", "bug:expected_result", "bug:reproduction_steps"].includes(ref)) return bugFields !== undefined && !text(bugFields[ref.slice(4)]);
      const match = /^evidence:(\d+)$/.exec(ref);
      return !match || !evidence[Number(match[1])]?.startsWith("[观察]");
    })) errors.push("验收条件和业务事实必须引用 bug 字段或存在的 [观察] evidence:N");
    return items;
  };
  const contract: RepairContract = {
    acceptance_cases: list("acceptance_cases").map(x => { const r = obj(x); return { given: text(r.given), when: text(r.when), then: text(r.then), source_refs: refs(r.source_refs) }; }),
    preserved_behaviors: strings(raw.preserved_behaviors),
    domain_facts: list("domain_facts").map(x => { const r = obj(x); return { concept: text(r.concept), meaning: text(r.meaning), source_refs: refs(r.source_refs) }; }),
    reuse_options: list("reuse_options").map(x => { const r = obj(x); return { symbol: text(r.symbol), action: text(r.action) as "reuse", reason: text(r.reason) }; }),
    open_questions: strings(raw.open_questions),
  };
  if (!contract.acceptance_cases.length || contract.acceptance_cases.some(c => !c.given || !c.when || !c.then)) errors.push("缺少完整业务验收条件 given/when/then");
  if (!contract.preserved_behaviors.length) errors.push("缺少正常对照/必须保持的行为");
  if (!contract.domain_facts.length || contract.domain_facts.some(f => !f.concept || !f.meaning)) errors.push("缺少关键业务概念及含义");
  if (!contract.reuse_options.length || contract.reuse_options.some(r => !r.symbol || !r.reason || !["reuse", "extract", "not_applicable"].includes(r.action))) errors.push("缺少经过核查的接口复用方案");
  if (!Array.isArray(raw.open_questions)) errors.push("缺少 open_questions 数组");
  if (contract.open_questions.length) errors.push(`业务条件尚未确认: ${contract.open_questions.join("；")}`);
  return { contract, errors: [...new Set(errors)] };
}

export function formatRepairContract(contract: RepairContract): string {
  return JSON.stringify(contract, null, 2);
}
