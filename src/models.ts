/** 核心数据模型：Bug / AgentResult / 工具函数。 */

const _HTML_TAG_RE = /<[^>]+>/g;
const _WS_RE = /[ \t ]+/g;

const _PRIORITY_LABEL: Record<string, string> = {
  high: "高", medium: "中", low: "低",
  urgent: "紧急", "1": "高", "2": "中", "3": "低",
};
const _SEVERITY_LABEL: Record<string, string> = {
  high: "高", medium: "中", low: "低",
  normal: "一般", serious: "严重", urgent: "紧急",
  fatal: "致命",
};

const _NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", middot: "·", times: "×", divide: "÷", deg: "°",
  bull: "•", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

/** 去掉 Tapd description 里的 HTML 标签并还原实体（对齐 Python html.unescape 常用子集）。 */
export function stripHtml(text: unknown): string {
  let out = String(text ?? "").replace(_HTML_TAG_RE, " ");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16))).replace(/&#(\d+);/g, (_m, dec: string) =>
    String.fromCodePoint(parseInt(dec, 10))).replace(/&([a-zA-Z]+);/g, (m, name: string) =>
    _NAMED_ENTITIES[name] ?? m);
  return out.replace(_WS_RE, " ").trim();
}

export function truncate(text: string | null | undefined, limit: number): string {
  const t = (text ?? "").trim();
  if (t.length <= limit) return t;
  return t.slice(0, limit) + "\n…(截断)";
}

export interface ManualAsset {
  path: string;
  reason?: string;
}

/** 单次失败尝试的重试证据：自动重试时喂给新 Agent 参考，也供管理台人工查看。
 *  opened_files 只含 default changelist 的（Agent 禁止 p4 change，编号 changelist 一律视为他人/已成功产物）。 */
export interface RetryEvidenceEntry {
  attempt: number;
  at: string;
  failure_reason: string;
  opened_files: string[];
  agent_summary: string;
  manual_assets: string[];
}

export interface Bug {
  id: string; // bug_id 是 >2^53 的大整数，全程用 string 传递避免丢精度
  workspace_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  priority_label: string;
  severity: string;
  module: string;
  current_owner: string;
  reporter: string;
  created: string;
  raw: Record<string, unknown>;
}

export function bugUrl(ws: string, id: string): string {
  return `https://www.tapd.cn/${ws}/bugtrace/bugs/view?bug_id=${id}`;
}

/** 解开 Tapd API 的 {"Bug": {...}} 实体包装。 */
function unwrapEntity(d: Record<string, unknown>): Record<string, unknown> {
  if (!("id" in d) && !("title" in d) && !("name" in d)) {
    for (const v of Object.values(d)) {
      if (v && typeof v === "object") {
        const cand = v as Record<string, unknown>;
        if ("id" in cand || "title" in cand || "name" in cand) return cand;
      }
    }
  }
  return d;
}

export function bugFromDict(d: unknown, workspaceId: unknown): Bug {
  const raw = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  const data = unwrapEntity(raw);
  const priority = String(data.priority ?? "");
  const rawPl = String(data.priority_label ?? "");
  // priority_label 可能是显示文本（"高"）也可能是码值（"medium"），统一转中文
  const priorityLabel = _PRIORITY_LABEL[rawPl] ?? rawPl ?? _PRIORITY_LABEL[priority] ?? "";
  const severityCode = String(data.severity ?? "");
  const rawSl = String(data.severity_label ?? "");
  const severity = _SEVERITY_LABEL[rawSl] ?? rawSl ?? _SEVERITY_LABEL[severityCode] ?? severityCode;
  const id = String(data.id ?? 0);
  return {
    id,
    workspace_id: String(workspaceId),
    title: String(data.name ?? data.title ?? ""),
    description: stripHtml(data.description),
    status: String(data.status ?? ""),
    priority,
    priority_label: priorityLabel,
    severity,
    module: String(data.module ?? ""),
    current_owner: String(data.current_owner ?? "").replace(/;+$/, ""),
    reporter: String(data.reporter ?? ""),
    created: String(data.created ?? ""),
    raw: data,
  };
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  changed_files: string[];
  manual_assets: ManualAsset[];
  blocked_reasons: string[];
  exit_code: number;
  log: string;
  raw_output: string;
}

export function hasCodeChanges(ar: AgentResult): boolean {
  return ar.changed_files.length > 0;
}

export function hasManualAssets(ar: AgentResult): boolean {
  return ar.manual_assets.length > 0;
}

export function agentResultFromFailure(exitCode: number, log: string): AgentResult {
  return { ok: false, summary: "", changed_files: [], manual_assets: [], blocked_reasons: [], exit_code: exitCode, log, raw_output: "" };
}

/** JSON 序列化（供 SQLite 存储）。 */
export function dumps(obj: unknown): string {
  return JSON.stringify(obj ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function loads<T = unknown>(text: string | null | undefined, def: T): T {
  if (!text) return def;
  try {
    return JSON.parse(text) as T;
  } catch {
    return def;
  }
}
