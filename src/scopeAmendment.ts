import { extractFinalJson } from "./agent.js";
import type { InvestigationResult } from "./repairWorkflow.js";

export function scopeAmendment(output: string): { files: string[]; reason: string } | undefined {
  const raw = extractFinalJson(output)?.scope_amendment;
  if (raw == null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("scope_amendment 格式错误");
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.files) || !data.files.length || data.files.some(f => typeof f !== "string")
    || typeof data.reason !== "string" || !data.reason.trim()) throw new Error("范围补充必须给出具体文件与复用/根因理由");
  return { files: [...new Set(data.files as string[])], reason: data.reason.trim() };
}

export function validateAmendedScope(previous: InvestigationResult, revised: InvestigationResult, proposed: string[], limit: number): void {
  if (!revised.ok) throw new Error("范围补充调查未通过: " + revised.validation_errors.join("；"));
  const allowed = new Set([...previous.planned_files, ...proposed]);
  if (revised.planned_files.length > limit || revised.planned_files.some(f => !allowed.has(f))
    || previous.planned_files.some(f => !revised.planned_files.includes(f))) throw new Error("范围补充超出申请或删除了原计划文件");
  if (JSON.stringify(previous.repair_contract) !== JSON.stringify(revised.repair_contract)) throw new Error("范围补充不得改变既定业务验收条件");
}
