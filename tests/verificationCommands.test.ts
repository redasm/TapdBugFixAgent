import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";
import { runVerificationPipeline } from "../src/verify.js";
import { formatVerificationCommand, parseVerificationCommands, resolveVerificationCommand } from "../src/verificationCommands.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "existing-tests-"));
  roots.push(root);
  const repo = path.join(root, "repo"), tests = path.join(repo, "custom tests");
  fs.mkdirSync(tests, { recursive: true });
  const testFile = path.join(tests, "existing.test.mjs");
  fs.writeFileSync(testFile, "import test from 'node:test'; import assert from 'node:assert/strict'; test('existing project test', () => assert.equal(2 + 2, 4));");
  return { root, repo, tests, testFile };
}

describe("reuse existing test projects", () => {
  it("runs unmodified native tests from a user-selected directory and records execution evidence", async () => {
    const { repo, testFile } = fixture();
    const original = fs.readFileSync(testFile, "utf8");
    const result = await runVerificationPipeline(repo, [{ command: "node --test existing.test.mjs", cwd: "custom tests", timeout_sec: 10 }], true);
    expect(result).toMatchObject({ ok: true, configured: true, steps: [{
      command: "node --test existing.test.mjs", cwd: path.join(repo, "custom tests"), timeout_sec: 10, ok: true,
    }] });
    expect(result.steps[0].output).toContain("existing project test");
    expect(fs.readFileSync(testFile, "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(testFile))).toEqual(["existing.test.mjs"]);
  });

  it("accepts an external absolute test path and stops delivery when native tests fail", async () => {
    const { repo, testFile } = fixture();
    const external = fixture();
    fs.writeFileSync(external.testFile, "import test from 'node:test'; import assert from 'node:assert/strict'; test('native failure', () => assert.fail('regression'));");
    const result = await runVerificationPipeline(repo, [
      { command: "node --test existing.test.mjs", cwd: external.tests },
      "node -e \"console.log('must-not-run')\"",
    ], true);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].output).toContain("native failure");
    expect(fs.existsSync(testFile)).toBe(true);
  });

  it("loads selected directories from the agent config and reports missing execution directories", () => {
    const { root, repo, tests } = fixture();
    const file = path.join(root, "config.yaml");
    fs.writeFileSync(file, JSON.stringify({ workspaces: [{ repos: [{ name: "project", path: repo,
      verify_cmds: [{ command: "node --test existing.test.mjs", cwd: "custom tests", timeout_sec: 12 }],
      additional_dirs: [{ name: "extra", path: repo, vcs: "git", base_branch: "main", verify_cmds: [{ command: "node --test existing.test.mjs", cwd: tests }] }],
    }] }] }));
    const config = loadConfig(file, path.join(root, ".env"), path.join(root, "overrides.yaml"));
    const loaded = config.workspaces[0].repos[0];
    expect(loaded.verify_cmds[0]).toEqual({ command: "node --test existing.test.mjs", cwd: "custom tests", timeout_sec: 12 });
    expect(loaded.additional_dirs![0].verify_cmds[0]).toEqual({ command: "node --test existing.test.mjs", cwd: tests });
    expect(validateConfig(config).filter(problem => problem.includes("验证执行目录"))).toEqual([]);
    loaded.verify_cmds = [{ command: "node --test", cwd: "missing" }];
    expect(validateConfig(config).join("\n")).toContain("验证执行目录不存在");
  });

  it("enforces the configured per-command timeout", async () => {
    const { repo, tests } = fixture();
    fs.writeFileSync(path.join(tests, "slow.cjs"), "setInterval(() => {}, 1000);");
    const result = await runVerificationPipeline(repo, [{ command: "node slow.cjs", cwd: tests, timeout_sec: 1 }], true);
    expect(result).toMatchObject({ ok: false, steps: [{ timeout_sec: 1, ok: false, output: "测试超时(1s)" }] });
  });
});

describe("verification command settings", () => {
  it("resolves root shorthand and renders selected cwd and timeout in the agent prompt", () => {
    const repo = path.resolve("repo");
    expect(resolveVerificationCommand(repo, "npm test", 1234)).toEqual({ command: "npm test", cwd: repo, timeout_ms: 1234 });
    expect(resolveVerificationCommand(repo, { command: "pytest", cwd: "../qa", timeout_sec: 20 })).toEqual({ command: "pytest", cwd: path.resolve(repo, "../qa"), timeout_ms: 20000 });
    expect(formatVerificationCommand({ command: "pytest", cwd: "../qa", timeout_sec: 20 })).toContain("执行目录: ../qa");
    expect(formatVerificationCommand("npm test")).toBe("npm test");
  });

  it.each([null, "npm test", [""], [{}], [{ command: "" }], [{ command: "npm test", cwd: 1 }],
    [{ command: "npm test", timeout_sec: 0 }], [{ command: "npm test", timeout_sec: 7201 }], [{ command: "npm test", directory: "tests" }]])("rejects invalid commands instead of stringifying configuration: %j", value => {
    expect(() => parseVerificationCommands(value)).toThrow("verify_cmds");
  });
});
