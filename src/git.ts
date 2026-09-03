/** Git 附加工作区：为每个 Bug 创建独立本地分支、收集 diff 并提交。 */

import { spawn } from "node:child_process";
import path from "node:path";

export class GitWorkspaceError extends Error {}

export interface GitBranchSession {
  baseBranch: string;
  baseCommit: string;
  branch: string;
}

export interface GitFinalizeResult {
  branch: string;
  commit: string;
  files: string[];
}

interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const runGit = (
  cwd: string,
  args: string[],
  timeout = 300000,
): Promise<GitRunResult> => new Promise((resolve, reject) => {
  const child = spawn("git", args, { cwd, windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => {
    child.kill();
    reject(new GitWorkspaceError(`git ${args.join(" ")} 超时(${Math.round(timeout / 1000)}s)`));
  }, timeout);
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(new GitWorkspaceError(`无法执行 git: ${error.message}`));
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ stdout, stderr, code });
  });
});

const runGitAllowDiff = async (cwd: string, args: string[]): Promise<string> => {
  const result = await runGit(cwd, args);
  if (result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.trim() || result.stdout.trim() || "git diff failed";
    throw new GitWorkspaceError(`git ${args.join(" ")} 失败: ${detail}`);
  }
  return result.stdout;
};

const timestamp = (date: Date): string => {
  const p = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
};

const safeBranchPart = (value: string): string => value
  .trim()
  .replace(/[\s~^:?*[\\\]]+/g, "-")
  .replace(/\.{2,}/g, ".")
  .replace(/^[-./]+|[-./]+$/g, "");

/** 分支格式：<主分支>_<作者><yyyyMMddHHmmss>。 */
export function buildFixBranchName(baseBranch: string, author: string, now = new Date()): string {
  const base = safeBranchPart(baseBranch);
  const owner = safeBranchPart(author);
  if (!base) throw new GitWorkspaceError("Git 主分支名为空或不合法");
  if (!owner) throw new GitWorkspaceError("Git 分支作者名为空或不合法");
  return `${base}_${owner}${timestamp(now)}`;
}

const lines = (value: string): string[] => value
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter(Boolean);

const normalizeIgnorePath = (value: string): string => {
  let normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (normalized.endsWith("/")) normalized += "**";
  return normalized;
};

export class GitWorkspace {
  readonly ignorePaths: string[];

  constructor(readonly path: string, ignorePaths: string[] = []) {
    this.ignorePaths = ignorePaths.map(normalizeIgnorePath).filter(Boolean);
  }

  private pathspec(): string[] {
    return ["--", ".", ...this.ignorePaths.map((item) => `:(exclude,glob)${item}`)];
  }

  private async run(args: string[], timeout?: number): Promise<string> {
    const result = await runGit(this.path, args, timeout);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || "git failed";
      throw new GitWorkspaceError(`git ${args.join(" ")} 失败: ${detail}`);
    }
    return result.stdout;
  }

  async assertRepository(): Promise<void> {
    const root = path.resolve((await this.run(["rev-parse", "--show-toplevel"])).trim());
    if (root.toLowerCase() !== path.resolve(this.path).toLowerCase()) {
      throw new GitWorkspaceError(`Git 附加目录必须是仓库根目录: ${this.path}（实际根目录 ${root}）`);
    }
  }

  async currentBranch(): Promise<string> {
    const branch = (await this.run(["branch", "--show-current"])).trim();
    if (!branch) throw new GitWorkspaceError(`Git 工作区处于 detached HEAD: ${this.path}`);
    return branch;
  }

  async assertClean(): Promise<void> {
    const dirty = (await this.run([
      // `all` 会把大型 UE 仓库中的每个未跟踪文件逐一展开，容易在分支准备阶段
      // 超时；`normal` 仍能可靠判断工作树是否脏，但只报告未跟踪目录一次。
      "status", "--porcelain", "--untracked-files=normal", ...this.pathspec(),
    ])).trim();
    if (dirty) {
      throw new GitWorkspaceError(
        `Git 工作区存在未提交改动，请先人工处理: ${this.path}\n${dirty.slice(0, 800)}`,
      );
    }
  }

  async prepareBranch(baseBranch: string, author: string, now = new Date()): Promise<GitBranchSession> {
    await this.assertRepository();
    await this.assertClean();
    const current = await this.currentBranch();
    if (current !== baseBranch) await this.run(["switch", baseBranch]);
    await this.assertClean();
    const baseCommit = (await this.run(["rev-parse", "HEAD"])).trim();
    const branch = buildFixBranchName(baseBranch, author, now);
    await this.run(["check-ref-format", "--branch", branch]);
    const exists = await runGit(this.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.code === 0) throw new GitWorkspaceError(`Git 分支已存在: ${branch}`);
    await this.run(["switch", "-c", branch]);
    return { baseBranch, baseCommit, branch };
  }

  async changedFiles(baseCommit: string): Promise<string[]> {
    const tracked = lines(await this.run(["diff", "--name-only", baseCommit, ...this.pathspec()]));
    const untracked = lines(await this.run([
      "ls-files", "--others", "--exclude-standard", ...this.pathspec(),
    ]));
    return [...new Set([...tracked, ...untracked])];
  }

  async diff(baseCommit: string): Promise<string> {
    const tracked = await this.run([
      "diff", "--no-ext-diff", "--binary", baseCommit, ...this.pathspec(),
    ]);
    const untracked = lines(await this.run([
      "ls-files", "--others", "--exclude-standard", ...this.pathspec(),
    ]));
    if (!untracked.length) return tracked;
    const patches = await Promise.all(untracked.map((file) =>
      runGitAllowDiff(this.path, ["diff", "--no-index", "--binary", "--", "/dev/null", file])));
    return [tracked, ...patches].filter(Boolean).join("\n");
  }

  async finalize(session: GitBranchSession, message: string): Promise<GitFinalizeResult | null> {
    const current = await this.currentBranch();
    if (current !== session.branch) {
      throw new GitWorkspaceError(
        `Git 分支被意外切换（期望 ${session.branch}，当前 ${current}）: ${this.path}`,
      );
    }
    const files = await this.changedFiles(session.baseCommit);
    if (!files.length) {
      await this.run(["switch", session.baseBranch]);
      await this.run(["branch", "-D", session.branch]);
      return null;
    }
    await this.run(["add", "--", ...files]);
    await this.run(["commit", "-m", message], 600000);
    const commit = (await this.run(["rev-parse", "HEAD"])).trim();
    await this.run(["switch", session.baseBranch]);
    return { branch: session.branch, commit, files };
  }

  /** 后续跨仓库收尾失败时，安全删除本次刚提交但尚未 push 的分支。 */
  async discardFinalized(session: GitBranchSession, result: GitFinalizeResult): Promise<void> {
    const current = await this.currentBranch();
    if (current !== session.baseBranch) {
      throw new GitWorkspaceError(
        `拒绝删除已提交分支：当前不在主分支 ${session.baseBranch}（当前 ${current}）: ${this.path}`,
      );
    }
    const head = (await this.run(["rev-parse", session.branch])).trim();
    if (head !== result.commit) {
      throw new GitWorkspaceError(
        `拒绝删除已变化的自动分支 ${session.branch}（期望 ${result.commit}，当前 ${head}）`,
      );
    }
    await this.assertClean();
    await this.run(["branch", "-D", session.branch]);
  }

  /** 仅清理本工具刚创建的分支；调用前工作区已验证为干净基线。 */
  async rollback(session: GitBranchSession): Promise<void> {
    const current = await this.currentBranch();
    if (current !== session.branch) {
      throw new GitWorkspaceError(
        `拒绝清理非当前自动分支（期望 ${session.branch}，当前 ${current}）: ${this.path}`,
      );
    }
    if (this.ignorePaths.length) {
      await this.run([
        "restore", "--source", session.baseCommit, "--staged", "--worktree", ...this.pathspec(),
      ], 600000);
      await this.run(["clean", "-fd", ...this.pathspec()], 600000);
    } else {
      await this.run(["reset", "--hard", session.baseCommit]);
      await this.run(["clean", "-fd"]);
    }
    await this.run(["switch", session.baseBranch]);
    await this.run(["branch", "-D", session.branch]);
  }
}
