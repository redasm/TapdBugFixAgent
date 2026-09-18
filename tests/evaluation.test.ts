import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateFiles, parseRunSpec } from "../src/evaluationCli.js";
import type { EvaluationDataset, PairedTrial } from "../src/evaluationDataset.js";

const dataset: EvaluationDataset = {
  version: 1, frozen_at: "2026-09-18T00:00:00Z",
  cases: [{
    bug_id: "b1", group: "async", split: "development", input_hash: "input",
    captured_at: "2026-09-17T00:00:00Z",
    replay: { status: "ready", source_revision: "source", resource_revision: "resource", acceptance_suite_hash: "suite" },
  }],
};
const trial: PairedTrial = {
  bug_id: "b1", group: "async", run: "recorded-name", repetition: 1,
  input_hash: "input", source_revision: "source", resource_revision: "resource", acceptance_suite_hash: "suite",
  budget_hash: "budget", model: "model", prompt_version: "p1", workspace_id: "workspace-A",
  attempt_id: "attempt-A", candidate_id: "candidate-A", human_outcome: "accepted_unchanged",
  seconds: 12, cost: null, tool_calls: 4, tool_errors: 1, retrieved_bug_ids: [], retrieved_groups: [],
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-eval-"));
  dirs.push(dir);
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  return { write, datasetPath: write("dataset.json", dataset) };
}

describe("frozen paired evaluation CLI", () => {
  it("validates frozen datasets without requiring trial files", () => {
    const { datasetPath } = fixture();
    expect(evaluateFiles(datasetPath, [])).toEqual({ valid: true, cases: 1, ready: 1 });
  });

  it("compares JSONL trials using explicit run names and counts no-output trials", () => {
    const { datasetPath, write } = fixture();
    const a = write("a.jsonl", trial);
    const b = write("b.jsonl", { ...trial, workspace_id: "workspace-B", attempt_id: "attempt-B", candidate_id: null, human_outcome: null });
    const reports = evaluateFiles(datasetPath, [{ name: "A", path: a }, { name: "B", path: b }]);
    expect(reports).toEqual([
      expect.objectContaining({ run: "A", top1_acceptance: 1, candidate_precision: 1, cost: null, tool_error_rate: 0.25 }),
      expect.objectContaining({ run: "B", top1_acceptance: 0, candidate_coverage: 0, candidate_precision: null }),
    ]);
  });

  it("rejects old datasets instead of returning a weighted score", () => {
    const { write } = fixture();
    const old = write("old.jsonl", { bug_id: "b1", expected_files: ["a.ts"], requires_verification: true });
    expect(() => evaluateFiles(old, [])).toThrow("数据集版本");
  });

  it("rejects empty datasets and invalid replay status", () => {
    const { write } = fixture();
    expect(() => evaluateFiles(write("empty.json", { ...dataset, cases: [] }), [])).toThrow("为空");
    expect(() => evaluateFiles(write("invalid.json", { ...dataset, cases: [{ ...dataset.cases[0], replay: { status: "legacy" } }] }), [])).toThrow("重放状态");
  });

  it("rejects missing comparison results and duplicate run names", () => {
    const { datasetPath, write } = fixture();
    const a = write("a.jsonl", trial), empty = write("empty.jsonl", trial);
    fs.writeFileSync(empty, "");
    expect(() => evaluateFiles(datasetPath, [{ name: "A", path: a }, { name: "B", path: empty }])).toThrow("结果为空");
    expect(() => evaluateFiles(datasetPath, [{ name: "A", path: a }, { name: "A", path: a }])).toThrow("名称");
  });

  it("reports the actual line of malformed JSONL", () => {
    const { datasetPath, write } = fixture();
    const broken = write("broken.jsonl", trial);
    fs.appendFileSync(broken, "\n\n{broken");
    expect(() => evaluateFiles(datasetPath, [{ name: "broken", path: broken }])).toThrow(broken + ":3");
  });

  it("preserves Windows drive letters in result specifications", () => {
    expect(parseRunSpec("model=C:\\eval\\model.jsonl")).toEqual({ name: "model", path: "C:\\eval\\model.jsonl" });
    expect(() => parseRunSpec("missing-name")).toThrow("name=path");
  });
});
