/** Tapd MCP 客户端：通过 MCP 协议调用「腾讯云 TAPD MCP Server」。
 *
 * 个人访问令牌（TAPD_ACCESS_TOKEN）比 API 账号好申请，不需要公司管理员开权限。
 *
 * 两种传输：
 * - streamable-http：url 填腾讯云托管 MCP 的专属连接地址（tapd.mcp.url），可选 token
 * - stdio：本地启动服务端（command+args，如 npx --no-install @xihe-lab/tapd-mcp-server），
 *   通过 env 传入 TAPD_ACCESS_TOKEN
 *
 * 用官方 @modelcontextprotocol/sdk 的 Client，连接后运行时 listTools() 自动发现工具，
 * 按名称/描述匹配到四个操作（list_bugs / get_bug / update_bug / add_comment），
 * 参数按 schema 过滤。工具名可用 config.yaml tapd.mcp.tool_map 显式覆盖。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { bugFromDict } from "./models.js";
import type { Bug } from "./models.js";
import { TapdError } from "./tapd.js";

const _BUG_HINTS = ["bug", "defect", "缺陷", "bugtrace", "bug_trace"];

// 已确认的官方 mcp-server-tapd / @xihe-lab/tapd-mcp-server 工具名（可被 config 覆盖）
const _DEFAULT_TOOL_MAP: Record<string, string> = {
  list_bugs: "tapd_get_bugs",
  get_bug: "tapd_get_bugs", // 传 id 取单个
  update_bug: "tapd_update_bug",
  add_comment: "tapd_create_comment", // 注意内容参数是 description
};

const _OP_VERBS: Record<string, string[]> = {
  list_bugs: ["list", "query", "search", "get", "view", "获取", "查询", "列表", "我的", "拉取"],
  get_bug: ["get", "detail", "info", "find", "获取", "详情", "查询", "查找"],
  update_bug: ["update", "edit", "modify", "change", "set", "更新", "修改", "编辑", "变更"],
  add_comment: ["add", "create", "comment", "新增", "添加", "评论", "创建"],
};

const _TOOL_MAP_KEYS = ["list_bugs", "get_bug", "update_bug", "add_comment"] as const;

function lower(text: unknown): string {
  return String(text ?? "").toLowerCase();
}

function inputProps(tool: Tool): Record<string, unknown> | undefined {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return schema?.properties;
}

/** 在已发现工具里按名称/描述为操作挑选最合适的工具名（启发式兜底）。 */
function matchTool(tools: Record<string, Tool>, op: string): string | undefined {
  const exact = Object.keys(tools).filter(
    (n) => n === op || n.endsWith(op) || op.endsWith(n),
  );
  if (exact.length) return exact.sort((a, b) => a.length - b.length)[0];

  const verbs = _OP_VERBS[op] ?? [];
  const needComment = op === "add_comment";
  let bestName: string | undefined;
  let bestScore = 0;
  for (const [name, tool] of Object.entries(tools)) {
    const desc = lower(tool.description ?? "");
    const hay = lower(name) + " " + desc;
    if (op !== "add_comment" && !_BUG_HINTS.some((h) => hay.includes(h))) continue;
    if (needComment && !hay.includes("comment") && !hay.includes("评论")) continue;
    if ((op === "list_bugs" || op === "get_bug") && name.includes("count")) continue;
    let score = verbs.reduce((acc, v) => acc + (hay.includes(v) ? 1 : 0), 0);
    // 参数加分：列表类工具通常带 limit/page/current_owner
    const props = inputProps(tool);
    if (props) {
      if ("limit" in props && "page" in props) score += 2;
      if ("current_owner" in props) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestScore > 0 ? bestName : undefined;
}

function tryParseJson(text: string): unknown {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // 尝试从文本中提取 json 代码块
  }
  const m = /```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```/s.exec(t);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** 处理 mcp2 的 structuredContent={'result': <值>} 包装，并尝试把 JSON 字符串解析为对象。 */
function unwrap(value: unknown): unknown {
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length && keys.every((k) => k === "result")) {
      value = (value as Record<string, unknown>).result;
    }
  }
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) value = parsed;
  }
  return value;
}

interface LooseCallResult {
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
  structured_content?: unknown;
  isError?: boolean;
  is_error?: boolean;
}

/** 把 MCP CallToolResult 归一化为 {text, data, isError}。 */
function normalizeToolResult(result: unknown): { text: string; data: unknown; isError: boolean } {
  const r = (result ?? {}) as LooseCallResult;
  const textParts: string[] = [];
  for (const block of r.content ?? []) {
    if (block && typeof block === "object" && "text" in block && block.text) {
      textParts.push(String(block.text));
    }
  }
  let data = unwrap(r.structuredContent ?? r.structured_content ?? undefined);
  if (data === undefined) data = tryParseJson(textParts.join("\n"));
  return { text: textParts.join("\n"), data, isError: Boolean(r.isError ?? r.is_error) };
}

function extractList(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["data", "items", "bugs", "list", "result", "records"]) {
      const val = (data as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val;
    }
  }
  return undefined;
}

/** 把 schema 属性类型强转（如 workspace_id 要求 number、id 要求 string）。 */
function coerce(value: unknown, prop: unknown): unknown {
  if (!prop || typeof prop !== "object") return value;
  const p = prop as { type?: string };
  const ptype = p.type;
  if ((ptype === "integer" || ptype === "number") && typeof value === "string") {
    const n = ptype === "integer" ? Number.parseInt(value, 10) : Number.parseFloat(value);
    return Number.isNaN(n) ? value : n;
  }
  if (ptype === "boolean" && typeof value === "string") {
    return ["1", "true", "yes", "是", "y"].includes(value.trim().toLowerCase());
  }
  if (ptype === "string" && typeof value !== "string") return String(value);
  return value;
}

export class TapdMcpClient {
  workspaceId: string;
  private mcp: Record<string, unknown>;
  private toolMap: Record<string, string>;
  private client: Client | undefined;
  private tools: Record<string, Tool> = {};
  private connecting: Promise<void> | undefined;

  constructor(workspaceId: string, mcpCfg: Record<string, unknown> = {}) {
    this.workspaceId = String(workspaceId);
    this.mcp = mcpCfg;
    this.toolMap = {
      ..._DEFAULT_TOOL_MAP,
      ...((this.mcp.tool_map ?? {}) as Record<string, string>),
    };
  }

  private env(): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    const cfg = this.mcp;
    if (cfg.access_token) env.TAPD_ACCESS_TOKEN = String(cfg.access_token);
    if (cfg.api_user) env.TAPD_API_USER = String(cfg.api_user);
    if (cfg.api_password) env.TAPD_API_PASSWORD = String(cfg.api_password);
    if (cfg.api_base_url) env.TAPD_API_BASE_URL = String(cfg.api_base_url);
    if (cfg.tapd_base_url) env.TAPD_BASE_URL = String(cfg.tapd_base_url);
    env.TAPD_DEFAULT_WORKSPACE_ID = this.workspaceId;
    return env;
  }

  private makeTransport(): StdioClientTransport | StreamableHTTPClientTransport {
    const transport = String(this.mcp.transport ?? "streamable-http");
    if (transport === "stdio") {
      return new StdioClientTransport({
        command: String(this.mcp.command ?? "uvx"),
        args: Array.isArray(this.mcp.args) ? (this.mcp.args as string[]).map(String) : ["mcp-server-tapd"],
        env: this.env(),
        stderr: "pipe",
      });
    }
    const url = String(this.mcp.url ?? "");
    if (!url) {
      throw new TapdError(
        "未配置 Tapd MCP 的 url（config.yaml tapd.mcp.url），" +
        "在腾讯云控制台 MCP Server 页面获取托管连接地址；或改用 transport: stdio",
      );
    }
    const token = String(this.mcp.token ?? process.env.MCP_TOKEN ?? "");
    if (token) {
      return new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
    }
    return new StreamableHTTPClientTransport(new URL(url));
  }

  private async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async doConnect(): Promise<void> {
    const transport = this.makeTransport();
    const client = new Client({ name: "tapd-bugfix-agent", version: "0.2.0" });
    await client.connect(transport);
    const result = await client.listTools();
    this.tools = {};
    for (const t of result.tools ?? []) this.tools[t.name] = t;
    this.client = client;
  }

  private async call(name: string, arguments_: Record<string, unknown>, timeoutMs = 120000): Promise<{ text: string; data: unknown; isError: boolean }> {
    await this.connect();
    const result = await Promise.race([
      this.client!.callTool({ name, arguments: arguments_ }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new TapdError(`调用 MCP 工具 ${name} 超时(${Math.round(timeoutMs / 1000)}s)`)), timeoutMs),
      ),
    ]);
    return normalizeToolResult(result);
  }

  private toolFor(op: string): string {
    const override = this.toolMap[op];
    if (override && this.tools[override]) return override;
    const name = matchTool(this.tools, op);
    if (!name) {
      throw new TapdError(
        `未找到适配 ${op} 的 MCP 工具。可用工具: ${Object.keys(this.tools).sort().join(", ")}。` +
        `可用 config.yaml tapd.mcp.tool_map.${op} 显式指定。`,
      );
    }
    return name;
  }

  private filterArgs(name: string, kwargs: Record<string, unknown>): Record<string, unknown> {
    const tool = this.tools[name];
    const props = tool ? inputProps(tool) : undefined;
    if (!props) return { ...kwargs };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kwargs)) {
      if (k in props) out[k] = coerce(v, props[k]);
    }
    return out;
  }

  private parseBug(data: unknown, bugId?: string): Bug {
    let d = data;
    if (Array.isArray(d)) d = d[0] ?? {};
    if (d && typeof d === "object") {
      const obj = d as Record<string, unknown>;
      for (const key of ["data", "result", "bug"]) {
        const val = obj[key];
        if (Array.isArray(val) && val.length) {
          d = val[0];
          break;
        }
        if (val && typeof val === "object") {
          d = val;
          break;
        }
      }
      const obj2 = d as Record<string, unknown>;
      if (!("id" in obj2) && !("title" in obj2)) {
        for (const v of Object.values(obj2)) {
          if (v && typeof v === "object") {
            const cand = v as Record<string, unknown>;
            if ("id" in cand || "title" in cand) {
              d = cand;
              break;
            }
          }
        }
      }
    }
    if (!d || typeof d !== "object") {
      throw new TapdError(`无法从 MCP 结果解析 Bug: ${String(data ?? "").slice(0, 300)}`);
    }
    const obj = d as Record<string, unknown>;
    if (obj.id === undefined || obj.id === null || obj.id === "") obj.id = bugId ?? 0;
    return bugFromDict(obj, this.workspaceId);
  }

  // ---------- 业务接口（与 REST TapdClient 对齐）----------
  // 注意：toolFor 依赖 this.tools，必须先 connect()（listTools 填充）再取工具名。
  async listBugs(currentOwner?: string): Promise<Bug[]> {
    await this.connect();
    const name = this.toolFor("list_bugs");
    const kwargs: Record<string, unknown> = {
      workspace_id: this.workspaceId,
      current_owner: currentOwner ?? "",
      owner: currentOwner ?? "",
      workspaceId: this.workspaceId,
      limit: 200,
      page: 1,
    };
    const result = await this.call(name, this.filterArgs(name, kwargs));
    if (result.isError) {
      throw new TapdError(`MCP 工具 ${name} 报错: ${result.text.slice(0, 300)}`);
    }
    const items = extractList(result.data);
    if (items === undefined) {
      throw new TapdError(
        `MCP 工具 ${name} 返回无法解析的列表（原始输出）:\n${result.text.slice(0, 800)}`,
      );
    }
    return items.filter((it) => it && typeof it === "object").map(
      (it) => bugFromDict(it, this.workspaceId),
    );
  }

  async getBug(bugId: string): Promise<Bug> {
    await this.connect();
    const name = this.toolFor("get_bug");
    const kwargs: Record<string, unknown> = {
      workspace_id: this.workspaceId,
      id: bugId,
      bug_id: bugId,
      workspaceId: this.workspaceId,
    };
    const result = await this.call(name, this.filterArgs(name, kwargs));
    return this.parseBug(result.data, bugId);
  }

  async updateBug(bugId: string, fields: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const name = this.toolFor("update_bug");
    const kwargs: Record<string, unknown> = {
      workspace_id: this.workspaceId,
      id: bugId,
      bug_id: bugId,
      workspaceId: this.workspaceId,
      ...fields,
    };
    return this.call(name, this.filterArgs(name, kwargs));
  }

  async addComment(bugId: string, content: string): Promise<unknown> {
    await this.connect();
    const name = this.toolFor("add_comment");
    const kwargs: Record<string, unknown> = {
      workspace_id: this.workspaceId,
      id: bugId,
      bug_id: bugId,
      entry_id: bugId,
      entry_type: "bug",
      content,
      description: content, // tapd_create_comment 的内容参数是 description
      workspaceId: this.workspaceId,
    };
    return this.call(name, this.filterArgs(name, kwargs));
  }

  // ---------- 调试 ----------
  async dumpTools(): Promise<string> {
    await this.connect();
    const lines = [`发现 ${Object.keys(this.tools).length} 个 MCP 工具：`];
    for (const name of Object.keys(this.tools).sort()) {
      const tool = this.tools[name];
      const desc = (tool.description ?? "").trim();
      const props = Object.keys(inputProps(tool) ?? {}).join(", ");
      lines.push(`- ${name}: ${desc.slice(0, 80)}  args=(${props})`);
    }
    return lines.join("\n");
  }
}

export { _TOOL_MAP_KEYS };
