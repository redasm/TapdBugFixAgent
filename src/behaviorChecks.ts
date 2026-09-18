import { AgentCancelledError } from "./agent.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { evidenceHash } from "./attemptAudit.js";
import { sourceEvidence } from "./sourceEvidence.js";
import { discoverBehaviorSuites, type BehaviorChecksConfig } from "./behaviorDiscovery.js";

export interface BehaviorCaseResult { id: string; kind: "reproduction" | "regression"; status: "pass" | "fail" | "error"; detail: string }
export interface FrozenBehaviorCheck {
  name: string; source: string; suite_hash: string; timeout_sec: number; before: BehaviorCaseResult[];
  files: string[]; before_sources: ReturnType<typeof sourceEvidence>;
}
export interface BehaviorVerification {
  level: "L0" | "L1"; ok: boolean; reproduced: boolean;
  checks: Array<{ name: string; suite_hash: string; before: BehaviorCaseResult[]; after: BehaviorCaseResult[];
    before_sources?: ReturnType<typeof sourceEvidence>; after_sources?: ReturnType<typeof sourceEvidence> }>;
  unverified_items: string[];
}

export async function runBehaviorSource(source: string, root: string, timeoutSec = 30, cancel?: { readonly cancelled: boolean }): Promise<BehaviorCaseResult[]> {
  if (cancel?.cancelled) throw new AgentCancelledError("行为测试已取消");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-behavior-"));
  const suite = path.join(dir, "frozen.mjs");
  fs.writeFileSync(suite, source);
  const runner = fileURLToPath(new URL("./behaviorRunner.js", import.meta.url));
  const tsRunner = runner.replace(/\.js$/, ".ts");
  const args = fs.existsSync(runner) ? [runner, suite, root] : ["--import", "tsx", tsRunner, suite, root];
  try {
    return await new Promise(resolve => {
      const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", error = "", timedOut = false;
      let cancelled = false, stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        if (process.platform === "win32" && child.pid) execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }, () => child.kill());
        else child.kill("SIGKILL");
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutSec) * 1000);
      const watchdog = setInterval(() => { if (cancel?.cancelled) { cancelled = true; stop(); } }, 200);
      child.stdout.on("data", chunk => { output = (output + chunk).slice(-100000); });
      child.stderr.on("data", chunk => { error = (error + chunk).slice(-2000); });
      const fail = (message: string): BehaviorCaseResult[] => [{ id: "suite-execution", kind: "regression", status: "error", detail: message }];
      child.on("error", e => { clearTimeout(timer); clearInterval(watchdog); resolve(fail(String(e))); });
      child.on("close", code => {
        clearTimeout(timer);
        clearInterval(watchdog);
        if (cancelled) return resolve(fail("行为测试已取消"));
        if (timedOut) return resolve(fail("行为测试超时；不属于 Bug 复现"));
        const line = output.split(/\r?\n/).reverse().find(line => line.startsWith("BEHAVIOR_RESULT:"));
        try {
          const rows = JSON.parse(line?.slice("BEHAVIOR_RESULT:".length) || "null") as BehaviorCaseResult[];
          if (code !== 0 || !Array.isArray(rows) || !rows.length || rows.some(r =>
            !r.id || !["reproduction", "regression"].includes(r.kind) || !["pass", "fail", "error"].includes(r.status))
            || new Set(rows.map(r => r.id)).size !== rows.length) throw Error(error || "行为测试协议不完整");
          resolve(rows);
        } catch (e) { resolve(fail(String(e))); }
      });
    });
  } finally {
    // Only this newly-created temporary directory is removed, after the process has exited.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function prepareBehaviorChecks(config: BehaviorChecksConfig | undefined, root: string, plannedFiles: string[], cancel?: { readonly cancelled: boolean }): Promise<FrozenBehaviorCheck[]> {
  if (cancel?.cancelled) throw new AgentCancelledError("行为测试已取消");
  const normalize = (file: string) => {
    const normalized = file.replace(/\\/g, "/").replace(/^project:/i, "").replace(/^\.\//, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const planned = new Set(plannedFiles.map(normalize));
  const selected = discoverBehaviorSuites(config).filter(c => c.files.some(file => planned.has(normalize(file))));
  const frozen: FrozenBehaviorCheck[] = [];
  for (const c of selected) {
    const source = c.source;
    frozen.push({ name: c.name, source, suite_hash: evidenceHash(source), timeout_sec: c.timeout_sec,
      files: c.files, before_sources: sourceEvidence(c.files, [{ alias: "project", path: root }]),
      before: await runBehaviorSource(source, root, c.timeout_sec, cancel) });
  }
  return frozen;
}

export async function verifyBehaviorChecks(checks: FrozenBehaviorCheck[], root: string, cancel?: { readonly cancelled: boolean }): Promise<BehaviorVerification> {
  const results: BehaviorVerification["checks"] = [];
  for (const c of checks) results.push({ name: c.name, suite_hash: c.suite_hash, before: c.before,
    before_sources: c.before_sources, after_sources: sourceEvidence(c.files, [{ alias: "project", path: root }]),
    after: await runBehaviorSource(c.source, root, c.timeout_sec, cancel) });
  if (cancel?.cancelled) throw new AgentCancelledError("行为测试已取消");
  return assessBehaviorResults(results);
}

export function assessBehaviorResults(checks: BehaviorVerification["checks"]): BehaviorVerification {
  const gaps: string[] = [];
  let failed = false, reproduced = false, normalCovered = false, valid = 0;
  for (const check of checks) {
    const before = new Map(check.before.map(c => [c.id, c]));
    if (check.before.some(c => c.status === "error") || check.after.some(c => c.status === "error")) gaps.push(`${check.name}: 环境或执行错误，不能宣称已验证`);
    const sameCases = check.before.length === check.after.length && check.after.every(a => before.get(a.id)?.kind === a.kind);
    if (!sameCases) { failed = true; gaps.push(`${check.name}: 前后测试集合不一致`); continue; }
    for (const after of check.after) {
      const old = before.get(after.id)!;
      if (old.kind === "regression" && old.status === "pass" && after.status === "pass") normalCovered = true;
      if (old.kind === "reproduction" && old.status === "fail" && after.status === "pass") reproduced = true;
      if (after.status === "fail" && (old.kind === "reproduction" || old.status === "pass")) failed = true;
    }
    if (check.after.every(c => c.status === "pass") && !check.before.some(c => c.status === "error")) valid++;
  }
  if (!checks.length) gaps.push("未配置匹配的业务行为测试，仅有静态验证；需人工验收");
  if (checks.length && !reproduced) gaps.push("没有修复前失败、修复后通过的目标行为证据");
  if (checks.length && !normalCovered) gaps.push("缺少修复前后均通过的正常对照场景");
  return { level: valid === checks.length && reproduced && normalCovered && !failed && checks.length > 0 ? "L1" : "L0", ok: !failed, reproduced, checks, unverified_items: gaps };
}
