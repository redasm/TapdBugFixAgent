/** 验证门：确认 Agent 改动被 p4 正确记录 + 测试通过。
 *
 * 流程：
 * 1. p4 opened 非空（Agent 确实开了文件）
 * 2. p4 reconcile -n 兜底：若 Agent 改了文件却没 p4 edit，自动 reconcile 打开，防止改动丢失
 * 3. 运行仓库测试命令
 */

import { spawn } from "node:child_process";
import type { OpenedFile, P4Client } from "./p4.js";

export class VerificationError extends Error {}

/** 确保 Agent 的改动都在 p4 中打开，返回 opened 列表。 */
export async function checkAndPrepareP4(p4: P4Client): Promise<OpenedFile[]> {
  const opened = await p4.opened();
  const preview = await p4.reconcilePreview();

  if (!opened.length && !preview.trim()) {
    throw new VerificationError("Agent 未打开任何文件（未产生改动，或遗漏 p4 edit）");
  }

  if (preview.trim()) {
    await p4.reconcile();
    const openedAfter = await p4.opened();
    if (!openedAfter.length) {
      throw new VerificationError("reconcile 后仍无 opened 文件");
    }
    return openedAfter;
  }

  return opened;
}

export interface TestResult {
  ok: boolean;
  output: string;
}

/** 运行测试命令，返回 (是否通过, 输出尾部)。未配置测试命令视为通过。 */
export function runTests(repoPath: string, testCmd: string, timeout = 600000): Promise<TestResult> {
  if (!testCmd || !testCmd.trim()) {
    return Promise.resolve({ ok: true, output: "(未配置测试命令，跳过)" });
  }
  return new Promise((resolve) => {
    const child = spawn(testCmd, {
      shell: true,
      cwd: repoPath,
      windowsHide: true,
    });
    let output = "";
    const sink = (d: Buffer) => {
      output += d.toString();
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: `测试超时(${Math.round(timeout / 1000)}s)` });
    }, timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `无法运行测试命令: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.slice(-1500) });
    });
  });
}
