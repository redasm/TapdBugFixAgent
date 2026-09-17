import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// P4 ignore files do not affect rg. Keep recursive searches out of generated trees.
const SEARCH_EXCLUDES = [
  ".git", "node_modules", "Binaries", "Intermediate", "DerivedDataCache", "Saved",
  "Logs", "SoundBanks", "AiAgent", ".agents", "Content/Aki/JavaScript",
];

export interface SearchInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export function defaultSearchPaths(repo: string, plannedFiles: string[] = []): string[] {
  const planned = [...new Set(plannedFiles.map((file) => path.dirname(file)))];
  if (planned.length) return planned;
  const candidates = ["TypeScript/Src", "Source", "src", "lib", "app", "tests", "test"]
    .map((dir) => path.join(repo, dir))
    .filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  return candidates.length ? candidates : [repo];
}

export function searchArguments(
  kind: "grep" | "find", input: SearchInput, cwd: string, defaults: string[],
): { args: string[]; paths: string[]; limit: number } {
  const target = path.resolve(cwd, input.path || ".");
  const paths = target === path.resolve(cwd) && defaults.length ? defaults : [target];
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit || 100)));
  const args = kind === "find"
    ? ["--files", "--hidden", "--color=never", "--glob", input.pattern]
    : ["--line-number", "--with-filename", "--color=never", "--hidden", "--max-columns", "500",
      "--max-count", String(limit)];
  if (kind === "grep") {
    if (input.ignoreCase) args.push("--ignore-case");
    if (input.literal) args.push("--fixed-strings");
    if (input.glob) args.push("--glob", input.glob);
    if (input.context) args.push("--context", String(Math.max(0, Math.min(10, Math.floor(input.context)))));
  }
  for (const dir of SEARCH_EXCLUDES) args.push("--glob", `!**/${dir}/**`);
  args.push("--glob", "!**/[nN][uU][lL]", "--glob", "!**/*.{uasset,umap,pak,ucas,utoc,pdb,dll,exe}");
  args.push("--", ...(kind === "grep" ? [input.pattern] : []), ...paths);
  return { args, paths, limit };
}

/** A search timeout returns partial results to the model, without killing its investigation. */
export async function runSearch(
  command: string, args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; maxLines?: number },
): Promise<{ output: string; timedOut: boolean; truncated: boolean }> {
  if (options.signal?.aborted) throw new Error("搜索已取消");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const maxBytes = options.maxBytes ?? 32000;
    const maxLines = options.maxLines ?? 200;
    let output = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const stop = () => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 30000);
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
    child.stdout.on("data", (data: Buffer) => {
      if (truncated) return;
      output += data.toString();
      const lines = output.split("\n");
      if (Buffer.byteLength(output) > maxBytes || lines.length > maxLines) {
        output = Buffer.from(lines.slice(0, maxLines).join("\n")).subarray(0, maxBytes).toString();
        truncated = true;
        stop();
      }
    });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      if (options.signal?.aborted) return reject(new Error("搜索已取消"));
      if (!timedOut && !truncated && code !== 0 && code !== 1) {
        return reject(new Error(`搜索失败 (${code}): ${stderr || output}`));
      }
      resolve({ output: output.trim(), timedOut, truncated });
    });
  });
}
