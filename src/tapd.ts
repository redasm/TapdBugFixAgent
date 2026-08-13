/** Tapd 后端客户端。
 *
 * - TapdClient：OpenAPI REST（HTTP Basic Auth，api_user/api_password）
 * - TapdMcpClient：MCP（个人访问令牌，@modelcontextprotocol/sdk）——见 tapdMcp.ts
 * - createTapdClient：按 config.tapd.backend 返回对应实现
 */

import { bugFromDict } from "./models.js";
import type { Bug } from "./models.js";
import type { Config } from "./config.js";
import { TapdMcpClient } from "./tapdMcp.js";

const BASE_URL = "https://api.tapd.cn";
const PAGE_SIZE = 200;
const RETRY_TIMES = 2;
const RETRY_BACKOFF_MS = 2000;
const TIMEOUT_MS = 30000;

export class TapdError extends Error {}

export interface TapdBackend {
  listBugs(currentOwner?: string): Promise<Bug[]>;
  getBug(bugId: string): Promise<Bug>;
  updateBug(bugId: string, fields: Record<string, unknown>): Promise<unknown>;
  addComment(bugId: string, content: string): Promise<unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TapdClient implements TapdBackend {
  private apiUser: string;
  private apiPassword: string;
  workspaceId: string;

  constructor(apiUser: string, apiPassword: string, workspaceId: string) {
    this.apiUser = apiUser;
    this.apiPassword = apiPassword;
    this.workspaceId = String(workspaceId);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    query: Record<string, unknown> = {},
    data: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      "User-Agent": "TapdBugFixAgent/0.2",
    };
    if (this.apiUser) {
      headers.Authorization = "Basic " + Buffer.from(`${this.apiUser}:${this.apiPassword}`).toString("base64");
    }
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(data)) params.set(k, String(v));
      body = params.toString();
    }

    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
      try {
        const resp = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (resp.status === 429 || [500, 502, 503, 504].includes(resp.status)) {
          if (attempt < RETRY_TIMES) {
            await sleep(RETRY_BACKOFF_MS * (attempt + 1));
            continue;
          }
        }
        if (!resp.ok) {
          const text = await resp.text();
          throw new TapdError(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }
        const payload = (await resp.json()) as Record<string, unknown>;
        if (payload.status !== 1) {
          throw new TapdError(`Tapd 返回异常状态: ${JSON.stringify(payload)}`);
        }
        return payload;
      } catch (exc) {
        lastErr = exc instanceof Error ? exc : new Error(String(exc));
        if (attempt < RETRY_TIMES) {
          await sleep(RETRY_BACKOFF_MS * (attempt + 1));
          continue;
        }
      }
    }
    throw new TapdError(`Tapd 请求失败 ${method} ${path}: ${lastErr?.message ?? lastErr}`);
  }

  /** 拉取全部匹配的 bug（自动翻页）。 */
  async listBugs(currentOwner?: string): Promise<Bug[]> {
    const out: Bug[] = [];
    let page = 1;
    for (;;) {
      const params: Record<string, unknown> = {
        workspace_id: this.workspaceId,
        limit: PAGE_SIZE,
        page,
      };
      if (currentOwner) params.current_owner = currentOwner;
      const payload = await this.request("GET", "/bugs", params);
      const items = (payload.data ?? []) as unknown[];
      for (const it of items) out.push(bugFromDict(it, this.workspaceId));
      if (items.length < PAGE_SIZE) break;
      page += 1;
    }
    return out;
  }

  async getBug(bugId: string): Promise<Bug> {
    const payload = await this.request("GET", "/bugs", { workspace_id: this.workspaceId, id: bugId });
    const data = payload.data;
    if (data && typeof data === "object") {
      return bugFromDict(data, this.workspaceId);
    }
    return bugFromDict({ id: bugId }, this.workspaceId);
  }

  /** 更新 bug 字段（如 status / current_owner）。 */
  async updateBug(bugId: string, fields: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/bugs", {}, { workspace_id: this.workspaceId, id: bugId, ...fields });
  }

  async addComment(bugId: string, content: string): Promise<unknown> {
    return this.request("POST", "/bugs/add_comment", {}, {
      workspace_id: this.workspaceId,
      entry_type: "bug",
      entry_id: bugId,
      content,
    });
  }
}

export function createTapdClient(config: Config, workspaceId: string): TapdBackend {
  const tapd = config.tapd as Record<string, unknown>;
  if (String(tapd.backend ?? "rest") === "mcp") {
    return new TapdMcpClient(workspaceId, (tapd.mcp ?? {}) as Record<string, unknown>);
  }
  return new TapdClient(
    String(tapd.api_user ?? ""),
    String(tapd.api_password ?? ""),
    workspaceId,
  );
}
