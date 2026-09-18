import type { InvestigationResult } from "./repairWorkflow.js";

/** A checkpoint is evidence for further reading, never permission to implement. */
export interface InvestigationProgress {
  version: 1;
  tool_calls: string[];
  findings: string[];
  open_questions: string[];
  trace: string;
  repair_contract?: InvestigationResult["repair_contract"];
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
  const newQuestions = [...result.blocked_reasons, ...result.validation_errors];
  const hasSpecificGap = newQuestions.some((question) => /^(调查证据尚未收敛|业务条件尚未确认)/.test(question));
  const questions = result.ok ? [] : hasSpecificGap ? newQuestions : [...(previous?.open_questions ?? []), ...newQuestions];
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
  };
}
