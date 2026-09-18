import { codeRelations } from "../codeRelations.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultSearchPaths, runSearch, searchArguments, type SearchInput } from "../search.js";

interface PiExtensionApi {
  registerTool(tool: Record<string, unknown>): void;
  on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => void): void;
}

export default function scopedSearchExtension(pi: PiExtensionApi): void {
  const localRg = path.join(os.homedir(), ".pi", "agent", "bin", process.platform === "win32" ? "rg.exe" : "rg");
  const rg = process.env.TAPD_BUGFIX_RG_PATH || (fs.existsSync(localRg) ? localRg : "rg");
  const configured = JSON.parse(process.env.TAPD_BUGFIX_SEARCH_PATHS || "[]") as string[];
  for (const [name, mode] of [["lookup_symbol", "symbol"], ["find_references", "references"], ["find_related_implementations", "related"]] as const) {
    pi.registerTool({ name, label: name, description: "只读 TypeScript AST 检索。指定具体模块目录、符号名；返回行号、源码哈希与片段。引用为标识符候选，须核实类型身份；最多300文件/2秒。",
      parameters: { type: "object", properties: { path: { type: "string" }, symbol: { type: "string" }, limit: { type: "number" } }, required: ["path", "symbol"] },
      async execute(_id: string, input: {path:string;symbol:string;limit?:number}, signal?:AbortSignal, _update?:unknown, ctx?:{cwd:string}) {
        if(signal?.aborted) throw new Error("检索已取消");
        const result=codeRelations(ctx?.cwd||process.cwd(),input.path,input.symbol,mode,input.limit);
        return { content: [{type:"text",text:JSON.stringify(result)}],details:result };
      },
    });
  }
  // Shell searches also need a per-command deadline; builds keep their original timeout.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const command = String(event.input.command ?? "");
    if (/(?:^|[\s;&|])(?:rg|fd|find|Get-ChildItem)(?:\s|$)/i.test(command)) {
      const timeout = Number(event.input.timeout);
      event.input.timeout = timeout > 0 ? Math.min(timeout, 30) : 30;
    }
  });
  for (const kind of ["grep", "find"] as const) {
    pi.registerTool({
      name: kind,
      label: `${kind} (scoped)`,
      description: `${kind === "grep" ? "搜索源码内容" : "按 glob 查找文件"}。默认仅搜索源码/计划文件所在目录，跳过生成产物和 nul。单次最多 30 秒，超时返回已找到的结果；可显式指定相关目录扩大范围。`,
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" },
          ignoreCase: { type: "boolean" }, literal: { type: "boolean" },
          context: { type: "number" }, limit: { type: "number" },
        },
        required: ["pattern"],
      },
      async execute(_id: string, input: SearchInput, signal?: AbortSignal, _update?: unknown, ctx?: { cwd: string }) {
        const cwd = ctx?.cwd || process.cwd();
        const scope = searchArguments(kind, input, cwd, configured.length ? configured : defaultSearchPaths(cwd));
        const result = await runSearch(rg, scope.args, { cwd, signal, maxLines: scope.limit * (kind === "grep" ? 3 : 1) });
        const text = [
          `搜索范围: ${scope.paths.join(", ")}（递归搜索排除生成目录、二进制和 nul；需要这些内容时直接读取文件）`,
          result.output || (result.timedOut ? "超时前未取得匹配；不能据此排除候选。" : "未找到匹配。"),
          result.timedOut ? "搜索达到 30 秒，已停止本次搜索。请缩小目录/文件类型范围后继续，不要重复原范围。" : "",
          result.truncated ? "结果已截断，请收窄范围。" : "",
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], details: { paths: scope.paths, ...result } };
      },
    });
  }
}
