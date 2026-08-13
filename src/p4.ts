/** p4 (Perforce) 命令封装。
 *
 * 所有操作限定在指定的 client workspace 内，通过子进程 env 注入
 * P4PORT/P4CLIENT/P4USER/P4PASSWD。安全约定：本模块只提供
 * sync / opened / diff / reconcile / revert / change 相关操作；
 * submit 仅由 auto 模式显式调用。
 *
 * 全部方法异步（Promise），避免 p4 sync 等长命令阻塞 Node 事件循环。
 */

import { spawn } from "node:child_process";

// config.p4 键 -> 环境变量名
const _P4_ENV_MAP: Record<string, string> = {
  port: "P4PORT",
  client: "P4CLIENT",
  user: "P4USER",
  password: "P4PASSWD",
  config: "P4CONFIG",
};

/** 把 config.p4 段转成 P4 环境变量（port/client/user/password/config）。
 *  空值跳过。编排器（P4Client）和 Agent（pi）共用此 helper，保证两边
 *  用的 client/认证完全一致 —— 否则 Agent 的 p4 edit 落在别的 client 里，
 *  reconcile 后 opened 为空，导致「修复失败：未打开任何文件」。 */
export function p4EnvFromConfig(configP4: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, envName] of Object.entries(_P4_ENV_MAP)) {
    const val = configP4[key];
    if (val) env[envName] = String(val);
  }
  return env;
}

// p4 opened 行格式（注意 `change` 是 changelist 占位词，两种形态都有它）:
//   `//depot/path#rev - action default change (type)`
//   `//depot/path#rev - action change 1234 (type)`
// 之前正则写成 `(\S+)\s+#\S+`（路径与 #rev 间要求空白）且漏了 `default` 后的 `change`
// → 真实输出永远匹配失败 → opened() 恒返回空 → 所有成功修复都被误判「无 opened 文件」。
const _OPENED_RE = /^(\S+)#\S+\s+-\s+(\S+)\s+(?:default\s+change|change\s+(\d+))\s*\(([^)]*)\)/;
const _CHANGE_CREATED_RE = /Change\s+(\d+)\s+created/i;

export interface OpenedFile {
  depot: string;
  action: string;
  changelist: string;
  type: string;
}

export class P4Error extends Error {}

export function setSpecField(spec: string, field: string, value: string): string {
  const lines = spec.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(field + ":")) {
      out.push(field + ":");
      const valueLines = value.split(/\r?\n/);
      for (const vl of valueLines) out.push(vl ? "\t" + vl : "\t");
      i += 1;
      while (i < lines.length && (lines[i].startsWith("\t") || lines[i].startsWith(" "))) {
        i += 1;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n") + "\n";
}

interface P4RunOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
}

function runP4(args: string[], opts: P4RunOpts): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("p4", args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new P4Error(`p4 ${args.join(" ")} 超时(${Math.round((opts.timeout ?? 120000) / 1000)}s)`));
    }, opts.timeout ?? 120000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new P4Error(`无法执行 p4: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

export class P4Client {
  path: string;
  env: NodeJS.ProcessEnv;

  constructor(workspacePath: string, configP4: Record<string, string> = {}) {
    this.path = workspacePath;
    this.env = { ...process.env, ...p4EnvFromConfig(configP4) };
  }

  async run(args: string[], inputText?: string, timeout = 120000): Promise<string> {
    const { stdout, stderr, code } = await runP4(args, {
      cwd: this.path, env: this.env, input: inputText, timeout,
    });
    if (code !== 0) {
      const err = stderr.trim() || stdout.trim() || "p4 failed";
      throw new P4Error(`p4 ${args.join(" ")} 失败: ${err}`);
    }
    return stdout;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- 只读 ----------
  async sync(timeout = 600000, retries = 3, retryDelay = 5000): Promise<string> {
    let lastErr: P4Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await this.run(["sync"], undefined, timeout);
      } catch (exc) {
        lastErr = exc as P4Error;
        if (attempt < retries - 1) await this.sleep(retryDelay);
      }
    }
    throw lastErr;
  }

  /** 返回打开的文件列表。 */
  async opened(): Promise<OpenedFile[]> {
    let out: string;
    try {
      out = await this.run(["opened"]);
    } catch {
      return [];
    }
    const result: OpenedFile[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = _OPENED_RE.exec(line);
      if (m) {
        result.push({
          depot: m[1],
          action: m[2],
          changelist: m[3] || "default",
          type: m[4],
        });
      }
    }
    return result;
  }

  /** default changelist 内改动的 unified diff。 */
  async diffUnified(): Promise<string> {
    try {
      return await this.run(["diff", "-du"]);
    } catch {
      return "";
    }
  }

  /** 检测"改了文件但没 p4 edit/p4 add"的磁盘差异（-n 预览）。 */
  async reconcilePreview(): Promise<string> {
    try {
      return await this.run(["reconcile", "-n"]);
    } catch {
      return "";
    }
  }

  // ---------- 写操作（编排器专用）----------
  async reconcile(): Promise<string> {
    return this.run(["reconcile"]);
  }

  async revert(files: string[]): Promise<string> {
    if (!files.length) return "";
    return this.run(["revert", ...files]);
  }

  async changeSpec(cl?: number): Promise<string> {
    const args = ["change", "-o"];
    if (cl !== undefined) args.push(String(cl));
    return this.run(args);
  }

  /** 创建新的 pending changelist，返回编号。
   *  传 files 时只把这些文件移入新 changelist（default 中其它文件保持不动）；
   *  不传则按 p4 默认行为把 default 全部 opened 文件移过去 —— 成功路径必须传当前
   *  bug 的文件列表，否则其它 bug 失败遗留的 default 文件会混进本 changelist。 */
  async createPending(description: string, files?: string[]): Promise<number> {
    let spec = await this.changeSpec();
    spec = setSpecField(spec, "Description", description);
    if (files && files.length) {
      spec = setSpecField(spec, "Files", files.join("\n"));
    }
    const out = await this.run(["change", "-i"], spec);
    const m = _CHANGE_CREATED_RE.exec(out);
    if (!m) throw new P4Error(`无法解析创建 changelist 的输出: ${out.trim().slice(0, 300)}`);
    return Number(m[1]);
  }

  async updateDescription(cl: number, description: string): Promise<void> {
    let spec = await this.changeSpec(cl);
    spec = setSpecField(spec, "Description", description);
    await this.run(["change", "-i"], spec);
  }

  /** 仅 auto 模式调用：提交 pending changelist。 */
  async submit(cl: number, description: string): Promise<string> {
    return this.run(["submit", "-d", description, String(cl)], undefined, 600000);
  }
}
