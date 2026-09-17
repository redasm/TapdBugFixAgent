import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSearchPaths, runSearch, searchArguments } from "../src/search.js";
import scopedSearch from "../src/piExtensions/scopedSearch.js";
import { AgentTimeoutError, AgentInvestigationLimitError, withRecoveryEvidence, formatRetryEvidence } from "../src/agent.js";
import { parseInvestigation } from "../src/repairWorkflow.js";

const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-search-test-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("bounded source search", () => {
  it("defaults to source, allows explicit related paths, and excludes generated trees", () => {
    const cwd = temp();
    fs.mkdirSync(path.join(cwd, "TypeScript", "Src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "Content", "Aki", "JavaScript"), { recursive: true });
    const defaults = defaultSearchPaths(cwd);
    expect(defaults).toEqual([path.join(cwd, "TypeScript", "Src")]);
    const broad = searchArguments("grep", { pattern: "Mark", path: "." }, cwd, defaults);
    expect(broad.paths).toEqual(defaults);
    expect(broad.args).toContain("!**/[nN][uU][lL]");
    expect(broad.args).toContain("!**/Content/Aki/JavaScript/**");
    expect(searchArguments("find", { pattern: "*.proto", path: "../Protocol" }, cwd, defaults).paths)
      .toEqual([path.resolve(cwd, "../Protocol")]);
  });

  it("actual rg search skips nul and generated matches, preserves file/line evidence", async () => {
    const cwd = temp();
    fs.mkdirSync(path.join(cwd, "src", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "Map.ts"), "const Mark = 1;\n");
    fs.writeFileSync(path.join(cwd, "src", "node_modules", "noise.ts"), "Mark generated noise\n");
    // Create a Windows reserved filename using its extended path form, as a P4 workspace can contain it.
    const nul = path.join(cwd, "src", "nul");
    fs.writeFileSync(process.platform === "win32" ? `\\\\?\\${nul}` : nul, "Mark invalid file\n");
    const scope = searchArguments("grep", { pattern: "Mark" }, cwd, defaultSearchPaths(cwd));
    const result = await runSearch("rg", scope.args, { cwd });
    expect(result.output).toContain("Map.ts:1:const Mark");
    expect(result.output).not.toContain("noise");
    expect(result.output).not.toContain("invalid file");
    const find = searchArguments("find", { pattern: "*.ts" }, cwd, defaultSearchPaths(cwd));
    expect((await runSearch("rg", find.args, { cwd })).output).toContain("Map.ts");
  });

  it("kills a stuck search, retains partial evidence and permits the next search", async () => {
    const cwd = temp();
    const result = await runSearch(process.execPath, ["-e", "console.log('Map.ts:42:observed');setInterval(()=>{},1000)"], { cwd, timeoutMs: 700 });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("Map.ts:42:observed");
    expect((await runSearch(process.execPath, ["-e", "console.log('next search')"], { cwd })).output).toBe("next search");
  });

  it("caps output, handles no matches and cancellation", async () => {
    const cwd = temp();
    const large = await runSearch(process.execPath, ["-e", "console.log('x'.repeat(10000));setInterval(()=>{},1000)"], { cwd, maxBytes: 200 });
    expect(large.truncated).toBe(true);
    expect(large.output.length).toBeLessThanOrEqual(200);
    expect((await runSearch(process.execPath, ["-e", "process.exit(1)"], { cwd })).output).toBe("");
    const controller = new AbortController();
    const pending = runSearch(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("取消");
  });

  it("caps shell search timeouts without shortening verification commands", () => {
    let hook: (event: { toolName: string; input: Record<string, unknown> }) => void = () => {};
    const names: string[] = [];
    scopedSearch({ registerTool: (tool) => { names.push(String(tool.name)); }, on: (_event, handler) => { hook = handler; } });
    expect(names).toEqual(["grep", "find"]);
    const search = { toolName: "bash", input: { command: 'cd "repo" && rg -n Mark .', timeout: 600 } };
    hook(search);
    expect(search.input.timeout).toBe(30);
    const build = { toolName: "bash", input: { command: "npm run build", timeout: 600 } };
    hook(build);
    expect(build.input.timeout).toBe(600);
  });
});

describe("recovery evidence", () => {
  it("preserves both failures and their traces, including through formatted retries", () => {
    const error = withRecoveryEvidence(new AgentTimeoutError("调查 600s 超时", "read Map.ts:42"),
      new AgentInvestigationLimitError("收尾 90s 停滞", "caller OnClick.ts:30")) as AgentInvestigationLimitError;
    expect(error.message).toContain("600s");
    expect(error.message).toContain("90s");
    const prompt = formatRetryEvidence([{ attempt: 1, at: "now", failure_reason: error.message,
      opened_files: [], agent_summary: "", manual_assets: [], partial_output: error.partialOutput,
      review_findings: { findings: ["proto field mismatch"] }, phase: "implementation" }]);
    expect(prompt).toContain("Map.ts:42");
    expect(prompt).toContain("OnClick.ts:30");
    expect(prompt).toContain("proto field mismatch");
  });

  it("keeps an unresolved call chain as investigation failure, not missing user information", () => {
    const result = parseInvestigation(JSON.stringify({ root_cause: "", evidence: [], planned_files: [],
      blocked_reasons: ["已找到 Map.ts，但未证实 OnClick 会进入预放置状态"] }));
    expect(result.ok).toBe(false);
    expect(result.blocked_reasons).toEqual([]);
    expect(result.validation_errors.join(" ")).toContain("未证实 OnClick");
  });
});
