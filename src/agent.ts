/** pi 编码 Agent 适配器：spawn `pi --mode json` + JSONL 事件流解析 + 取消/超时。
 *
 * - pi headless 模式输出 JSONL 事件：message_* / tool_execution_* / agent_end
 * - tool_execution_start/update/end 含 toolName+args → 实时进度（debug 级事件）
 * - message_update 的 text_delta → 实时进度
 * - agent_end.messages → 拼接最终文本，用 FINAL_RESULT: 标记解析结构化结果
 *
 * 取消/超时：watchdog 每 0.2s 轮询 cancel 事件 → Windows taskkill /F /T 杀整棵
 * 进程树（防孤儿 node 进程占 p4 文件锁），再 proc.kill()。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { Config, PiConfig } from "./config.js";
import { p4EnvFromConfig } from "./p4.js";
import type { AgentResult, Bug, RetryEvidenceEntry } from "./models.js";
import { truncate } from "./models.js";

export class AgentRuntimeError extends Error {}

export class AgentCancelledError extends AgentRuntimeError {}

export const FINAL_MARKER = "FINAL_RESULT:";

/** 取消令牌：web 暂停/关闭时置位，worker 用它中断当前 agent。 */
export class CancelEvent {
  private flag = false;
  set(): void {
    this.flag = true;
  }
  get cancelled(): boolean {
    return this.flag;
  }
}

// ---------------------------------------------------------------------------
// 子进程进程树清理
// ---------------------------------------------------------------------------
function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
        stdio: "ignore",
        timeout: 15000,
      });
    } catch {
      // 进程可能已退出
    }
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// JSONL 事件解析
// ---------------------------------------------------------------------------
interface ToolArgs {
  file_path?: unknown;
  command?: unknown;
  pattern?: unknown;
  path?: unknown;
  query?: unknown;
  cwd?: unknown;
}

/** 从 message.content 数组（或字符串）里拼出累计的文本。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("").trim();
}

export type ParsedProgress =
  | { kind: "text"; text: string }
  | { kind: "event"; msg: string };

/** 把一条 pi JSONL 事件行解析成进度项；无关行返回 undefined。
 *
 *  kind="text"：message_update 的文本增量（PiAgent 会把相邻增量合并后再上报，
 *  避免逐 token 落库把事件表刷爆——实测一次修复曾产生 2 万条 debug 事件）。
 *  kind="event"：工具调用等自成一条的进度消息。
 *
 *  pi 真实事件形状（pi-agent-core 确认）：
 *  - tool_execution_start: { type, toolName, args }
 *  - tool_execution_end:   { type, toolName, result }
 *  - message_update:       { type, message: { content:[...] },
 *                           assistantMessageEvent: { type:"text_delta", delta } }
 *    文本增量在 assistantMessageEvent.delta，累计全文在 message.content。
 */
export function parseProgress(line: string): ParsedProgress | undefined {
  const t = line.trim();
  if (!t) return undefined;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = d.type;
  if (type === "tool_execution_start") {
    const tool = String(d.toolName ?? "");
    const args = (d.args ?? {}) as ToolArgs;
    const target =
      args.file_path ?? args.command ?? args.pattern ?? args.path ?? args.query ?? args.cwd ?? "";
    return { kind: "event", msg: `Agent: ${tool} ${String(target).slice(0, 120)}` };
  }
  if (type === "tool_execution_end") {
    const tool = String(d.toolName ?? "");
    const result = (d.result ?? "") as unknown;
    // result 可能是字符串，也可能是 { content:[{type:"text",text}] }（pi 真实形状）
    let summary = "";
    if (typeof result === "string") {
      summary = result.trim().slice(0, 60);
    } else if (result && typeof result === "object") {
      const content = (result as { content?: unknown }).content;
      summary = contentText(content).slice(0, 60);
    }
    return { kind: "event", msg: `Agent: ${tool} 完成${summary ? ` · ${summary}` : ""}` };
  }
  if (type === "message_update") {
    // 只关心文本更新；thinking 增量太吵，跳过
    const ev = (d.assistantMessageEvent ?? {}) as {
      type?: string;
      delta?: unknown;
      content?: unknown;
    };
    if (ev.type !== "text_delta" && ev.type !== "text_end") return undefined;
    const full = contentText((d.message as { content?: unknown } | undefined)?.content);
    const delta =
      ev.type === "text_end" ? String(ev.content ?? "") : String(ev.delta ?? "");
    // 保留原文（含换行——PiAgent 靠它判断冲刷时机），清洗放到格式化时做
    const raw = delta.trim() ? delta : full;
    if (raw && raw.trim()) return { kind: "text", text: raw };
    return undefined;
  }
  return undefined;
}

/** 单行进度的格式化视图（兼容旧用法/测试）：文本增量格式化为 "Agent: <文本>"。 */
export function progressFromLine(line: string): string | undefined {
  const p = parseProgress(line);
  if (!p) return undefined;
  return p.kind === "text"
    ? `Agent: ${p.text.replace(/\s+/g, " ").trim().slice(-160)}`
    : p.msg;
}

/** 从 agent_end 事件的 messages 里拼出最终 assistant 文本。 */
function extractFinalTextFromEvent(d: Record<string, unknown>): string | undefined {
  const messages = d.messages;
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: unknown };
          if (b.type === "text" && b.text) parts.push(String(b.text));
        }
      }
    }
  }
  const out = parts.join("\n").trim();
  return out || undefined;
}

/** 从累计的 stdout 行里取最后一个 agent_end 事件的最终文本。 */
export function extractFinalText(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d.type === "agent_end") {
        const text = extractFinalTextFromEvent(d);
        if (text) return text;
      }
    } catch {
      // 非 JSON 行，忽略
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 结构化输出解析
// ---------------------------------------------------------------------------
function stripCodeFence(seg: string): string {
  let s = seg.trim();
  // 回归：这里曾写成 s.split("\n", 1)[1]——JS 的 split 带 limit 时结果数组只有 1 个
  // 元素，[1] 恒为 undefined，导致 ```json 围栏后的 JSON 整段变空串、解析必败。
  if (s.startsWith("```")) s = s.slice(s.indexOf("\n") + 1); // 去掉 ```json 开栏行
  const close = s.lastIndexOf("```");
  if (close !== -1) s = s.slice(0, close); // 去掉闭栏
  return s.trim();
}

/** 从 s[start]（须位于 '{'）做括号配平扫描，返回完整 JSON 对象子串。
 *  字符串/转义感知：字符串里的 '{' '}' '"' 不影响配平；未配平返回 undefined。
 *  用来容忍模型输出里 JSON 之后拖着的协议标签残渣（如网关泄漏的 </｜｜DSML｜｜...>）。 */
function balancedJsonAt(s: string, start: number): string | undefined {
  if (s[start] !== "{") return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

const RESULT_KEYS = ["summary", "changed_files", "manual_assets", "blocked_reasons"];

function looksLikeResult(obj: Record<string, unknown>): boolean {
  return RESULT_KEYS.some((k) => k in obj);
}

/** DeepSeek 系网关会把原生工具调用协议泄进文本，JSON 常被整体转义成
 *  {\"summary\": ...}（此时原文里的引号全被 \ 前置，字符串永不闭合）。 */
function unescapeJsonIsh(s: string): string {
  return s.includes('\\"') ? s.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : s;
}

/** 在一段文本里找首个可解析的结果 JSON：按原文配平→解析；失败再对反转义文本配平→解析。 */
function resultJsonFromSegment(seg: string): Record<string, unknown> | undefined {
  for (const candidate of [seg, unescapeJsonIsh(seg)]) {
    const brace = candidate.indexOf("{");
    if (brace === -1) continue;
    const obj = parseResultJson(balancedJsonAt(candidate, brace) ?? "");
    if (obj) return obj;
  }
  return undefined;
}

/** 解析候选 JSON 串。 */
function parseResultJson(raw: string): Record<string, unknown> | undefined {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    // 不是合法 JSON
  }
  return undefined;
}

/** 从 Agent 输出中提取最后的 FINAL_RESULT JSON。
 *  三级回退（都要能扛住输出尾部混入的协议标签/杂项文本）：
 *  1. FINAL_RESULT: 标记后的首个配平 JSON 对象（stripCodeFence 修好后围栏也认）；
 *  2. 最后一个 json 代码块里的配平 JSON；
 *  3. 从文本尾部向前找每个 '{' 的配平 JSON，且必须长得像结果对象（有些网关把
 *     FINAL_RESULT 标记本身也吞掉，但结果 JSON 总在输出的最后）。 */
export function extractFinalJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const idx = text.lastIndexOf(FINAL_MARKER);
  if (idx !== -1) {
    const obj = resultJsonFromSegment(stripCodeFence(text.slice(idx + FINAL_MARKER.length)));
    if (obj) return obj;
  }
  const blockRe = /```(?:json)?\s*(.*?)```/gs;
  const blocks = [...text.matchAll(blockRe)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const obj = resultJsonFromSegment(blocks[i][1].trim());
    if (obj) return obj;
  }
  for (const tail of [text.slice(-4000), unescapeJsonIsh(text.slice(-4000))]) {
    for (let i = tail.length - 1; i >= 0; i--) {
      if (tail[i] !== "{") continue;
      const cand = balancedJsonAt(tail, i);
      if (!cand) continue;
      const obj = parseResultJson(cand);
      if (obj && looksLikeResult(obj)) return obj;
    }
  }
  return undefined;
}

export function resultFromOutput(text: string, exitCode: number): AgentResult {
  const data = extractFinalJson(text);
  const ar: AgentResult = {
    ok: exitCode === 0,
    summary: "",
    changed_files: [],
    manual_assets: [],
    blocked_reasons: [],
    exit_code: exitCode,
    log: "",
    raw_output: (text ?? "").slice(0, 8000),
  };
  if (data) {
    ar.ok = true;
    ar.summary = String(data.summary ?? "");
    ar.changed_files = Array.isArray(data.changed_files)
      ? data.changed_files.map(String)
      : [];
    ar.manual_assets = Array.isArray(data.manual_assets)
      ? data.manual_assets.filter((a) => a && typeof a === "object").map(
          (a) => {
            const o = a as Record<string, unknown>;
            return { path: String(o.path ?? "?"), reason: String(o.reason ?? "") };
          },
        )
      : [];
    ar.blocked_reasons = Array.isArray(data.blocked_reasons)
      ? data.blocked_reasons.map(String)
      : [];
  } else if (exitCode === 0 && (text ?? "").trim()) {
    ar.summary = (text ?? "").trim().slice(-2000);
  }
  return ar;
}

// ---------------------------------------------------------------------------
// prompt 模板
// ---------------------------------------------------------------------------
/** 修复守则（防御性模式）：来自 deepseek-harness 的实际缺陷类别总结，按本仓库场景裁剪。
 *  文件缺失时静默跳过（不阻断 prompt 构造）；src 与 dist 布局一致（../prompts）。 */
const _PLAYBOOK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "defensive-patterns.md",
);
let _playbookCache: string | undefined;
let _playbookLoaded = false;

function loadPlaybook(): string | undefined {
  if (_playbookLoaded) return _playbookCache;
  _playbookLoaded = true;
  try {
    const text = fs.readFileSync(_PLAYBOOK_PATH, "utf-8").trim();
    // 先归一化行尾（git autocrlf 往返会把文件变 CRLF，标题剥离正则在 \r\n 下失配、
    // 标题整行漏进 prompt），再去 frontmatter 与首行标题，正文直接进 prompt
    const body = text
      .replace(/\r\n/g, "\n")
      .replace(/^---[\s\S]*?---\s*/, "")
      .replace(/^#[^\n]*\n/, "")
      .trim();
    _playbookCache = body ? body.slice(0, 4000) : undefined;
  } catch {
    // 无守则文件 = 不注入（向后兼容）
  }
  return _playbookCache;
}

/** 把失败尝试的证据压缩成提示文本（跨轮只传压缩证据，不传 Agent 轨迹）。
 *  空数组返回 ""。 */
export function formatRetryEvidence(entries: RetryEvidenceEntry[]): string {
  const es = (entries ?? []).filter((e) => e && typeof e === "object");
  if (!es.length) return "";
  const lines = [
    "以下是你之前自动处理该 Bug 的失败记录（工作区已被工具清理干净，可放心重新开始）:",
  ];
  for (const e of es) {
    lines.push(`- 第 ${e.attempt} 次尝试（${e.at || "?"}）失败，原因: ${e.failure_reason || "(无)"}`);
    if (e.agent_summary) lines.push(`  Agent 当时的说明: ${e.agent_summary}`);
    if (e.opened_files?.length) lines.push(`  当时改动/打开过的文件: ${e.opened_files.join(", ")}`);
    if (e.manual_assets?.length) lines.push(`  当时识别到的需人工资源: ${e.manual_assets.join(", ")}`);
  }
  lines.push("请结合以上线索继续排查并修复，避免重复同样的错误做法。");
  return lines.join("\n");
}

export function buildFixPrompt(
  bug: Bug,
  repoName: string,
  repoPath: string,
  testCmd: string,
  retryEvidence = "",
): string {
  const desc = truncate(bug.description, 2000).trim();
  const descText = desc || "（该 Bug 无描述文本）";
  const evidenceSection = retryEvidence.trim()
    ? `\n# 上一次尝试的记录（自动重试参考）\n${retryEvidence.trim()}\n`
    : "";
  const playbook = loadPlaybook();
  const playbookSection = playbook
    ? `\n# 修复守则（涉及异步/事件/生命周期/清理代码时必须对照）\n${playbook}\n`
    : "";
  return `你是自动修复 Tapd Bug 的编码 Agent。请修复下面的 Bug。

# Bug 信息
标题: ${bug.title}
优先级: ${bug.priority_label || bug.priority}
模块: ${bug.module}
TAPD 单号: ${bug.id}
描述:
${descText}

# 工作区规则（Perforce）
1. 修改任何已有文件前，先执行: p4 edit <文件>
2. 新建文件后执行: p4 add <文件>
3. 禁止使用: p4 submit / p4 revert / p4 sync / p4 change
4. 只把改动放进 default changelist。
5. 涉及 prefab / 场景 / 图集 / 表格(xlsx/csv/bytes) / 其他二进制资源时，不要强行修改；把它们列入「需人工处理资源」清单并说明原因。
6. 完成后不要提交。
${evidenceSection}${playbookSection}
# 定位要求
- 如果仅凭标题/模块无法在代码中定位问题，或缺少关键信息（如复现步骤、日志），**不要臆测硬改**；把缺什么写进 blocked_reasons 并停止。
- 优先在代码里搜索标题/模块相关的关键词来定位。

# 仓库
名称: ${repoName}
路径: ${repoPath}
测试命令: ${testCmd || "(无)"}
修改后请尽量运行测试确认。

# 输出要求（重要）
结束时，在最后输出一行（可放在 json 代码块里），严格使用以下格式：
FINAL_RESULT:
\`\`\`json
{"summary": "修复说明（中文，简述改动与验证结果）", "changed_files": ["相对仓库路径的文件"], "manual_assets": [{"path": "需人工处理的资源路径", "reason": "原因"}], "blocked_reasons": ["无法完成/缺少信息的原因"]}
\`\`\``;
}

// ---------------------------------------------------------------------------
// pi 适配器
// ---------------------------------------------------------------------------
export interface PiRunOptions {
  prompt: string;
  repoDir: string;
  timeoutS: number;
  onProgress?: (msg: string) => void;
  cancelEvent?: CancelEvent;
}

// ---------------------------------------------------------------------------
// pi models.json 注入（config.yaml 的 pi.provider → ~/.pi/agent/models.json）
// ---------------------------------------------------------------------------
const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const PI_MODELS_PATH = path.join(PI_AGENT_DIR, "models.json");

/** 有效 `--model` 值（`<provider>/<model_id>`）。未配置 provider / model_id 返回 ""（pi 用默认模型）。
 *  model_id 若已带 "/"（直接写全限定名）则原样返回，否则拼前缀。 */
export function effectivePiModel(pi: PiConfig): string {
  const p = pi.provider;
  if (!p || !p.id || !p.model_id) return "";
  return p.model_id.includes("/") ? p.model_id : `${p.id}/${p.model_id}`;
}

/** 把 config.yaml 的 pi.provider 段合并写入 ~/.pi/agent/models.json（仅配置了 provider 时）。
 *  - 只覆盖 providers.<id> 这一项，保留用户已配置的其它 provider / 内置 provider。
 *  - apiKey 优先取 p.api_key，否则取 p.api_key_env 的环境变量**名**（运行期由 pi 解析，
 *    密钥不落盘）。两者都缺则退化为 "ANTHROPIC_API_KEY"。
 *  - 模型 id 取 p.model_id（带 "/" 时取最后一段，与 effectivePiModel 的 --model 值对应）；
 *    缺 model_id 则不写（交给 pi 报错）。
 *  modelsPath 参数仅测试用。
 */
export function ensurePiModels(pi: PiConfig, modelsPath = PI_MODELS_PATH): void {
  const p = pi.provider;
  if (!p || !p.id || !p.base_url) return;
  const rawModel = p.model_id ?? "";
  const modelId = rawModel.includes("/") ? rawModel.split("/").pop() ?? "" : rawModel;
  if (!modelId) return;

  const apiKey = p.api_key ?? p.api_key_env ?? "ANTHROPIC_API_KEY";
  const entry: Record<string, unknown> = {
    baseUrl: p.base_url,
    api: "anthropic-messages",
    apiKey,
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: p.reasoning ?? true,
        input: ["text"],
        contextWindow: p.context_window ?? 200000,
        maxTokens: p.max_tokens ?? 32000,
      },
    ],
  };
  if (p.auth_header) entry.authHeader = true;

  let root: Record<string, unknown> = { providers: {} };
  try {
    if (fs.existsSync(modelsPath)) {
      const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
      if (parsed && typeof parsed === "object") root = parsed as Record<string, unknown>;
    }
  } catch {
    // 原文件损坏/不可解析：从空结构开始
  }
  const providers = (root.providers && typeof root.providers === "object"
    ? root.providers
    : {}) as Record<string, unknown>;
  providers[p.id] = entry;
  root.providers = providers;
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, JSON.stringify(root, null, 2) + "\n");
}

export class PiAgent {
  constructor(private config: Config) {}

  /** 解析要传给 pi `--skill` 的目录（绝对路径，仅仓库里实际存在的）。
   *  默认尝试团队共享的 .agents/skills 与 .agent/skills（同事两种拼法都有）；
   *  config.yaml pi.skill_dirs 可覆盖。指向 skills 子目录而非 .agents 根——
   *  pi 会把根下散置的 .md 也当 skill 加载（如 DSH 风格仓库的 notes/README）。 */
  private skillDirs(repoDir: string): string[] {
    const configured =
      this.config.pi.skill_dirs && this.config.pi.skill_dirs.length
        ? this.config.pi.skill_dirs
        : [".agents/skills", ".agent/skills"];
    const out: string[] = [];
    for (const dir of configured) {
      const abs = path.isAbsolute(dir) ? dir : path.resolve(repoDir, dir);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) out.push(abs);
      } catch {
        // 无法访问则跳过（不阻断 spawn）
      }
    }
    return out;
  }

  async run(opts: PiRunOptions): Promise<AgentResult> {
    // config.yaml 配置了 pi.provider 时，先合并写入 models.json（失败不阻断 spawn，pi 自带报错）
    try {
      ensurePiModels(this.config.pi);
    } catch (exc) {
      const msg = (exc as Error).message;
      opts.onProgress?.(`[警告] 写入 pi models.json 失败（已忽略）: ${msg}`);
    }

    // ---- Windows 多行参数传递修复 ----
    // spawn 走 shell:true（cmd.exe）时，含换行的 argv 会被 cmd 按换行拆成多个参数：
    // 多行 prompt 到 pi 手里变成碎片消息（只收到第一行被拆开的几段），丢失全部 Bug 信息
    // （表现为 Agent 无头绪乱转 / 零输出 / 跑满超时）。
    // 因此 Windows 上把 prompt 写入临时文件，用 pi 的 @file 语法传引用：参数本身无换行，
    // cmd 不会再拆；同时彻底规避 cmd 8191 字符命令行长度上限。POSIX execve 无此问题，直接传参。
    let promptArg = opts.prompt;
    let promptTmpDir: string | undefined;
    if (process.platform === "win32") {
      promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-"));
      const promptFile = path.join(promptTmpDir, "prompt.md");
      fs.writeFileSync(promptFile, opts.prompt, "utf-8");
      promptArg = `@${promptFile}`;
    }

    const args = ["--print", "--mode", "json", promptArg];
    // --print 必须加：缺了它会进交互模式，pi 挂在等输入 → 零输出、永不退出，
    // 表现为「处理中无进度 + 每次跑满 agent_timeout 超时」。--mode json 不隐含非交互。
    // 另一个挂起点是 spawn 的 stdin（见下方 stdio: ["ignore","pipe","pipe"]）：
    // 二者缺一都会让 pi 永远等输入，二者同时满足才能让 --print 真正执行。
    // 模型覆盖：由 provider 构造 `--model <provider>/<model_id>`；未配置则不传（pi 用默认模型）
    const model = effectivePiModel(this.config.pi);
    if (model) args.push("--model", model);
    // 团队共享 skill 目录：pi 只认 <cwd>/.pi/skills，团队仓库里大家放的是 .agent(s)/skills，
    // 用 --skill <目录>（可重复）挂载进去。只传仓库里实际存在的目录（相对路径按仓库根解析）。
    for (const dir of this.skillDirs(opts.repoDir)) {
      args.push("--skill", dir);
    }

    const isWin = process.platform === "win32";
    let proc: ChildProcess;
    try {
      proc = spawn("pi", args, {
        cwd: opts.repoDir,
        // 注入 config.p4 的 P4 环境变量（P4PORT/P4CLIENT/P4USER/P4PASSWD）。
        // 与 worker 的 P4Client 一致，否则 pi 落笔的 p4 edit 在默认 client 里，
        // 编排器 reconcile 后 opened 仍空 → 「修复失败：Agent 未打开任何文件」。
        env: { ...process.env, ...p4EnvFromConfig(this.config.p4) },
        shell: isWin, // Windows: cmd.exe 解析，才能执行 .cmd shim（npm 全局装的 pi.cmd）
        windowsHide: true,
        // 必须把 stdin 设为 ignore：spawn 默认 stdin 是 pipe 且无人关闭 → pi 的
        // readPipedStdin() 在非 TTY stdin 下会读完整个 stdin 等 'end' 事件，永不触发
        // → 挂在首响应之前、零输出、跑满 agent_timeout。ignore 让 pi 立即读到 EOF，
        // stdout/stderr 保持 pipe 供 JSONL 事件流解析。
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (exc) {
      throw new AgentRuntimeError(`无法执行 pi: ${(exc as Error).message}`);
    }

    const outLines: string[] = [];
    const errChunks: string[] = [];
    proc.stderr?.on("data", (d: Buffer) => (errChunks.push(d.toString())));

    // 文本增量合并：message_update 的 text_delta 每个 token 一条，逐条上报会把事件表
    // 刷爆（一次修复 2 万条 debug 事件）。攒到换行或 120 字符再发；工具事件直接透传。
    let textBuf = "";
    const flushText = () => {
      const t = textBuf.replace(/\s+/g, " ").trim();
      textBuf = "";
      if (t) opts.onProgress?.(`Agent: ${t.slice(-160)}`);
    };
    const onLine = (line: string) => {
      outLines.push(line);
      if (!opts.onProgress) return;
      try {
        const p = parseProgress(line);
        if (!p) return;
        if (p.kind === "text") {
          textBuf += p.text;
          if (textBuf.includes("\n") || textBuf.length >= 120) flushText();
        } else {
          flushText();
          opts.onProgress(p.msg);
        }
      } catch {
        // 进度回调失败不影响主流程
      }
    };
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on("line", onLine);

    const deadline = Date.now() + opts.timeoutS * 1000;
    const result = await new Promise<AgentResult>((resolve, reject) => {
      const watchdog = setInterval(() => {
        if (opts.cancelEvent?.cancelled) {
          killProcessTree(proc);
          clearInterval(watchdog);
          reject(new AgentCancelledError("Agent 调用被人工取消: pi"));
          return;
        }
        if (proc.exitCode !== null) {
          clearInterval(watchdog);
          return; // close 事件会负责 resolve
        }
        if (Date.now() > deadline) {
          killProcessTree(proc);
          clearInterval(watchdog);
          reject(new AgentRuntimeError(`Agent 调用超时(${opts.timeoutS}s): pi`));
        }
      }, 200);
      proc.on("error", (err) => {
        clearInterval(watchdog);
        reject(new AgentRuntimeError(`无法执行 pi: ${err.message}`));
      });
      proc.on("close", (code) => {
        clearInterval(watchdog);
        if (opts.cancelEvent?.cancelled) {
          reject(new AgentCancelledError("Agent 调用被人工取消: pi"));
          return;
        }
        try {
          flushText(); // 收尾：把缓冲里的最后一段文本进度发出去
          rl.close();
        } catch {
          // ignore
        }
        const finalText = extractFinalText(outLines);
        const ar = resultFromOutput(finalText || outLines.join("\n"), code ?? -1);
        ar.log = (errChunks.join("").slice(-1000) + "\n" + (finalText || outLines.join("\n")).slice(-2500)).trim();
        resolve(ar);
      });
    });

    try {
      return await result;
    } finally {
      // 清理 Windows 临时 prompt 文件
      if (promptTmpDir) {
        try {
          fs.rmSync(promptTmpDir, { recursive: true, force: true });
        } catch {
          // 清理失败不影响主流程
        }
      }
    }
  }
}
