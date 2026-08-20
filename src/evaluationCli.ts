/** JSONL 文件适配器：让历史 Bug 数据集可在 CI 中重复比较不同模型/Prompt。 */

import fs from "node:fs";

import {
  compareEvaluationRuns,
  evaluateRun,
  type EvaluationCandidate,
  type EvaluationCase,
  type EvaluationReport,
} from "./evaluation.js";

const readJsonLines = <T>(filePath: string): T[] => {
  const text = fs.readFileSync(filePath, "utf-8");
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (exc) {
      throw new Error(`${filePath}:${index + 1} 不是有效 JSON: ${(exc as Error).message}`);
    }
  });
};

export const evaluateFiles = (
  datasetPath: string,
  runs: Array<{ name: string; path: string }>,
): EvaluationReport[] => {
  const cases = readJsonLines<EvaluationCase>(datasetPath);
  if (!cases.length) throw new Error("评测数据集为空");
  const reports = runs.map((run) => evaluateRun(
    cases,
    readJsonLines<EvaluationCandidate>(run.path),
    run.name,
  ));
  return compareEvaluationRuns(reports);
};

export const parseRunSpec = (value: string): { name: string; path: string } => {
  const equals = value.indexOf("=");
  if (equals <= 0 || equals === value.length - 1) {
    throw new Error(`--result 必须使用 name=path 格式，当前: ${value}`);
  }
  return { name: value.slice(0, equals), path: value.slice(equals + 1) };
};
