/** 冻结 JSON 数据集与 JSONL 配对试验的唯一文件入口。 */
import fs from "node:fs";
import { comparePairedTrials, validateEvaluationDataset, type EvaluationDataset, type PairedTrial } from "./evaluationDataset.js";

const readJsonLines = <T>(filePath: string): T[] => {
  const rows: T[] = [];
  fs.readFileSync(filePath, "utf8").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (exc) {
      throw new Error(`${filePath}:${index + 1} 不是有效 JSON: ${(exc as Error).message}`);
    }
  });
  return rows;
};

export const parseRunSpec = (value: string): { name: string; path: string } => {
  const equals = value.indexOf("=");
  if (equals <= 0 || equals === value.length - 1) {
    throw new Error(`--result 必须使用 name=path 格式，当前: ${value}`);
  }
  return { name: value.slice(0, equals), path: value.slice(equals + 1) };
};

export function evaluateFiles(datasetPath: string, runs: Array<{ name: string; path: string }>) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")) as EvaluationDataset;
  validateEvaluationDataset(dataset);
  if (!runs.length) {
    return { valid: true, cases: dataset.cases.length, ready: dataset.cases.filter(c => c.replay.status === "ready").length };
  }
  if (runs.some(run => !run.name.trim()) || new Set(runs.map(run => run.name)).size !== runs.length) {
    throw new Error("试验组名称必须非空且唯一");
  }
  const trials = runs.flatMap(run => {
    const rows = readJsonLines<PairedTrial>(run.path);
    if (!rows.length) throw new Error(`试验组 ${run.name} 结果为空，无法进行配对比较`);
    return rows.map(trial => ({ ...trial, run: run.name }));
  });
  return comparePairedTrials(dataset, trials);
}
