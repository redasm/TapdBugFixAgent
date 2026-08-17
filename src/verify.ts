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

/** 确保 Agent 的改动都在 p4 中打开，返回 opened 列表。
 *  只收集 default changelist 的文件：pending changelist 的 Files 列表只允许
 *  default 里的文件（p4 change 规范），编号 changelist 是其它 bug 的产物。 */
export async function checkAndPrepareP4(p4: P4Client): Promise<OpenedFile[]> {
  const opened = await p4.opened("default");
  const preview = await p4.reconcilePreview();

  if (!opened.length && !preview.trim()) {
    const elsewhere = (await p4.opened()).filter((o) => o.changelist !== "default");
    const hint = elsewhere.length
      ? `（另有 ${elsewhere.length} 个文件开在编号 changelist ` +
        [...new Set(elsewhere.map((o) => o.changelist))].join(", ") +
        "——那是其它 bug 的 pending changelist，或 Agent 违规使用了 p4 change；本工具只收集 default changelist 的改动）"
      : "（未产生改动，或遗漏 p4 edit）";
    throw new VerificationError("Agent 未在 default changelist 打开任何文件" + hint);
  }

  if (preview.trim()) {
    await p4.reconcile();
    const openedAfter = await p4.opened("default");
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
