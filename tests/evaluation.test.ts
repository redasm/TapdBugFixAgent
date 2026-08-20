import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareEvaluationRuns,
  evaluateRun,
  type EvaluationCase,
  type EvaluationCandidate,
} from "../src/evaluation.js";
import { evaluateFiles, parseRunSpec } from "../src/evaluationCli.js";

const cases: EvaluationCase[] = [
  {
    bug_id: "b1",
    category: "async_state",
    expected_files: ["src/Settings.ts"],
    forbidden_files: ["src/Auth.ts"],
    requires_verification: true,
  },
  {
    bug_id: "b2",
    category: "null_guard",
    expected_files: ["src/Login.ts"],
    forbidden_files: [],
    requires_verification: true,
  },
];

const good: EvaluationCandidate[] = [
  {
    bug_id: "b1",
    changed_files: ["src/Settings.ts"],
    verification_ok: true,
    review_approved: true,
    human_outcome: "accepted_unchanged",
    reopened: false,
  },
  {
    bug_id: "b2",
    changed_files: ["src/Login.ts"],
    verification_ok: true,
    review_approved: true,
    human_outcome: "accepted_modified",
    reopened: false,
  },
];

describe("historical bug evaluation", () => {
  it("按验证、范围、评审和人工结果计算离线指标", () => {
    const report = evaluateRun(cases, good, "model-a");

    expect(report.total).toBe(2);
    expect(report.coverage).toBe(1);
    expect(report.verified_rate).toBe(1);
    expect(report.scope_precision).toBe(1);
    expect(report.review_pass_rate).toBe(1);
    expect(report.unchanged_acceptance_rate).toBe(0.5);
    expect(report.effective_fix_rate).toBe(1);
  });

  it("缺失结果、越界改动和 reopen 会降低得分", () => {
    const bad: EvaluationCandidate[] = [{
      bug_id: "b1",
      changed_files: ["src/Settings.ts", "src/Auth.ts"],
      verification_ok: false,
      review_approved: false,
      human_outcome: "rejected_overchange",
      reopened: true,
    }];
    const report = evaluateRun(cases, bad, "model-b");

    expect(report.coverage).toBe(0.5);
    expect(report.scope_precision).toBe(0);
    expect(report.effective_fix_rate).toBe(0);
  });

  it("比较多个模型或 Prompt 运行时按综合得分排序", () => {
    const strong = evaluateRun(cases, good, "strong");
    const weak = evaluateRun(cases, [{
      ...good[0],
      verification_ok: false,
      review_approved: false,
      human_outcome: "rejected_no_effect",
    }], "weak");

    const comparison = compareEvaluationRuns([weak, strong]);

    expect(comparison[0].name).toBe("strong");
    expect(comparison[0].score).toBeGreaterThan(comparison[1].score);
  });

  it("从 JSONL 数据集和多个结果文件生成可比较报告", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-eval-"));
    const dataset = path.join(dir, "cases.jsonl");
    const resultA = path.join(dir, "model-a.jsonl");
    const resultB = path.join(dir, "model-b.jsonl");
    fs.writeFileSync(dataset, cases.map((item) => JSON.stringify(item)).join("\n"));
    fs.writeFileSync(resultA, good.map((item) => JSON.stringify(item)).join("\n"));
    fs.writeFileSync(resultB, JSON.stringify({ ...good[0], verification_ok: false }));

    const reports = evaluateFiles(dataset, [
      { name: "model-a", path: resultA },
      { name: "model-b", path: resultB },
    ]);

    expect(reports.map((item) => item.name)).toEqual(["model-a", "model-b"]);
  });

  it("CLI 结果参数使用 name=path，保留 Windows 盘符", () => {
    expect(parseRunSpec("deepseek=C:\\eval\\deepseek.jsonl")).toEqual({
      name: "deepseek",
      path: "C:\\eval\\deepseek.jsonl",
    });
    expect(() => parseRunSpec("missing-name")).toThrow("name=path");
  });
});
