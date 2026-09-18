import path from "node:path";

/** String shorthand runs at the repository root; objects select an existing test project. */
export type VerificationCommand = string | {
  command: string;
  cwd?: string;
  timeout_sec?: number;
};

export function parseVerificationCommands(value: unknown): VerificationCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("verify_cmds 须为命令数组");
  return value.map((entry, index) => {
    const invalid = (reason: string): never => { throw new Error(`verify_cmds[${index}]: ${reason}`); };
    if (typeof entry === "string") return entry.trim() || invalid("命令不能为空");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid("须为命令字符串或 {command,cwd,timeout_sec}");
    const raw = entry as Record<string, unknown>;
    if (Object.keys(raw).some(key => !["command", "cwd", "timeout_sec"].includes(key))) return invalid("只支持 command、cwd、timeout_sec");
    if (typeof raw.command !== "string" || !raw.command.trim()) return invalid("command 不能为空");
    if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim() || raw.cwd.includes("\0"))) return invalid("cwd 须为执行目录");
    if (raw.timeout_sec !== undefined && (typeof raw.timeout_sec !== "number" || !Number.isFinite(raw.timeout_sec)
      || raw.timeout_sec < 1 || raw.timeout_sec > 7200)) return invalid("timeout_sec 须为 1–7200 秒");
    return { command: raw.command.trim(), ...(raw.cwd !== undefined ? { cwd: raw.cwd as string } : {}),
      ...(raw.timeout_sec !== undefined ? { timeout_sec: raw.timeout_sec as number } : {}) };
  });
}

export function resolveVerificationCommand(repoPath: string, entry: VerificationCommand, defaultTimeoutMs = 600000) {
  const spec = typeof entry === "string" ? { command: entry } : entry;
  return { command: spec.command, cwd: path.resolve(repoPath, spec.cwd ?? "."),
    timeout_ms: spec.timeout_sec === undefined ? defaultTimeoutMs : spec.timeout_sec * 1000 };
}

export function formatVerificationCommand(entry: VerificationCommand): string {
  if (typeof entry === "string") return entry;
  return `${entry.command} (执行目录: ${entry.cwd ?? "."}，相对所属仓库或绝对路径；超时: ${entry.timeout_sec ?? 600}秒)`;
}
