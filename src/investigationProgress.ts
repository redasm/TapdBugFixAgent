import type { InvestigationResult } from "./repairWorkflow.js";

/** A checkpoint is evidence for further reading, never permission to implement. */
export interface InvestigationProgress {
  version: 1;
  tool_calls: string[];
  findings: string[];
  /** 只放真正未解决的调查问题（业务未决问题 + 具体证据缺口）。
   *  校验缺项（validation_errors）不再混进这里：它们由继续调查提示的专门小节逐条给出，
   *  避免把“输出格式不完整”当成业务未决问题反复追问。 */
  open_questions: string[];
  trace: string;
  repair_contract?: InvestigationResult["repair_contract"];
  /** 已登记但尚未执行的验证限制：随断点一起保留，不得静默丢失。 */
  verification_limitations?: string[];
}

/** Preserve the entry point and the most recent work without duplicating retry prompts. */
export function compactInvestigationTrace(trace: string, limit = 18000): string {
  if (trace.length <= limit) return trace;
  const head = Math.floor(limit / 3);
  return `${trace.slice(0, head)}\n[中间轨迹已省略，未展示的内容不能视为已核实]\n${trace.slice(-(limit - head - 50))}`;
}

export function captureInvestigationProgress(
  trace: string,
  result: InvestigationResult,
  previous?: InvestigationProgress,
): InvestigationProgress {
  const unique = (items: string[], count: number) => [...new Set(items.filter(Boolean))].slice(-count);
  const calls = trace.split(/\r?\n/).filter((line) => /^工具 .+?:/.test(line)).map((line) => line.slice(0, 1000));
  // 断点里的 open_questions 只承载真正未解决的调查问题：具体证据缺口（blocked_reasons）
  // 与业务未决问题。validation_errors 是“本轮输出缺项”，作为独立参数交给继续调查提示，
  // 不能在这里被混成业务问题反复追问。
  const newQuestions = [...result.blocked_reasons, ...(result.open_questions ?? [])];
  const hasSpecificGap = newQuestions.some((question) => /^(调查证据尚未收敛|业务条件尚未确认)/.test(question));
  const questions = result.ok ? [] : hasSpecificGap ? newQuestions : [...(previous?.open_questions ?? []), ...newQuestions];
  const limitations = unique([...(previous?.verification_limitations ?? []), ...(result.verification_limitations ?? [])], 15)
    .map((line) => line.slice(0, 1500));
  const previousTrace = previous?.trace ?? "";
  const combinedTrace = previousTrace && trace && !trace.includes(previousTrace)
    ? `${previousTrace}\n[后续调查记录]\n${trace}` : trace || previousTrace;
  return {
    version: 1,
    tool_calls: unique([...(previous?.tool_calls ?? []), ...calls], 30),
    findings: unique([...(previous?.findings ?? []), ...result.evidence], 20).map((line) => line.slice(0, 1500)),
    open_questions: unique(questions, 15).map((line) => line.slice(0, 1500)),
    trace: compactInvestigationTrace(combinedTrace.trim()),
    repair_contract: result.repair_contract.acceptance_cases.length ? result.repair_contract : previous?.repair_contract,
    verification_limitations: limitations,
  };
}
