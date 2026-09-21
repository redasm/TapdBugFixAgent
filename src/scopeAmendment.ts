import fs from "node:fs";
import path from "node:path";

import { extractFinalJson } from "./agent.js";
import type { InvestigationResult } from "./repairWorkflow.js";
import type { ReviewResult } from "./review.js";
import { assessPlannedScope } from "./verify.js";

export function scopeAmendment(output: string): { files: string[]; reason: string } | undefined {
  const raw = extractFinalJson(output)?.scope_amendment;
  if (raw == null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("scope_amendment 格式错误");
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.files) || !data.files.length || data.files.some(f => typeof f !== "string")
    || typeof data.reason !== "string" || !data.reason.trim()) throw new Error("范围补充必须给出具体文件与复用/根因理由");
  return { files: [...new Set(data.files as string[])], reason: data.reason.trim() };
}

export function validateAmendedScope(previous: InvestigationResult, revised: InvestigationResult, proposed: string[], limit: number): void {
  if (!revised.ok) throw new Error("范围补充调查未通过: " + revised.validation_errors.join("；"));
  const allowed = new Set([...previous.planned_files, ...proposed]);
  if (revised.planned_files.length > limit || revised.planned_files.some(f => !allowed.has(f))
    || previous.planned_files.some(f => !revised.planned_files.includes(f))) throw new Error("范围补充超出申请或删除了原计划文件");
  if (JSON.stringify(previous.repair_contract) !== JSON.stringify(revised.repair_contract)) throw new Error("范围补充不得改变既定业务验收条件");
}

// ---------------------------------------------------------------------------
// 评审驱动的受控范围补充
//
// Reviewer 可以在驳回时要求修改调查阶段 planned_files 之外的文件。修正 Agent 照做后，
// 旧实现仍用原 planned_files 校验，必然抛「实际修改超出调查阶段计划范围」；若修正 Agent
// 按提示报告 blocked_reasons，也会直接失败并进入一次注定失败的重试。
//
// 这里给出一条受控通道：只有「评审自己明确指向、且位于配置根内、可定位到具体文件、
// 不超过 quality.max_changed_files」的文件才被加入本次有效计划范围；无法安全批准的
// 评审要求一律转人工阻塞，而不是进入无解的自动重试。范围门禁本身不被关闭：
// 没有任何评审指向的文件仍然照旧被 verifyCandidate 拒绝。
// ---------------------------------------------------------------------------

export interface ScopeRoot {
  alias: string;
  path: string;
}

export interface ReviewScopeAmendment {
  /** 评审输出中识别出、指向本工作区文件的引用（已清洗：去引号、去行号、统一分隔符）。 */
  requested: string[];
  /** 可安全纳入本次有效计划范围的文件（根别名:相对路径）。 */
  approved: string[];
  /** 评审明确要求、但无法安全纳入范围的文件（转人工阻塞）。 */
  unapprovable: string[];
  /** 提及但无法定位到本工作区的引用（多为其它仓库的引用/举证），仅记录，不影响门禁。 */
  unresolved: string[];
  /** 被上限或既有范围校验拒绝时的具体原因。 */
  reason: string;
}

const EMPTY_AMENDMENT: ReviewScopeAmendment = {
  requested: [], approved: [], unapprovable: [], unresolved: [], reason: "",
};

/** 评审明确表示「需要新建该文件」时才允许纳入尚不存在的具体文件（与调查阶段 [新文件] 规则一致）。 */
const NEW_FILE_HINT = /\[(?:新文件|新增)\]|(?:新建|新增)(?:测试)?文件/;
/** 形如 A/B/C.ts 的无别名相对路径；要求至少一段目录，避免匹配 `response.cooldownSeconds` 这类成员访问。 */
const PLAIN_PATH = /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+\.[A-Za-z][A-Za-z0-9]{0,5}/g;
/** 形如 project:TypeScript/Src/Foo.ts 的显式根别名引用。 */
const ALIASED_PATH = /([A-Za-z][A-Za-z0-9_]{0,15}):((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.[A-Za-z][A-Za-z0-9]{0,5})/g;

/** 清洗评审引用的装饰与定位后缀：反引号、引号、括号、行号/行区间、路径分隔符。 */
export const normalizeReference = (value: string): string => value
  .trim()
  .replace(/^[`'"“”‘’*（(【\[]+/, "")
  .replace(/[`'"“”‘’*）)】\]]+$/, "")
  .replace(/[，。；、,;]+$/, "")
  .replace(/:\d+(?:[-–~]\d+)?$/, "")
  .replace(/\\/g, "/")
  .replace(/^\.\//, "")
  .trim();

const hasExtension = (value: string): boolean =>
  /[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(value);

/** 把安全相对路径解析到根内绝对路径；越界、绝对路径、通配符与 `..` 一律拒绝。 */
const safeResolve = (rootPath: string, relative: string): string | undefined => {
  const rel = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || /^[a-z]:\//i.test(rel)) return undefined;
  if (/[*?"<>|]/.test(rel) || rel.includes("\0")) return undefined;
  if (rel.split("/").some((part) => part === "..")) return undefined;
  const base = path.resolve(rootPath);
  const target = path.resolve(base, ...rel.split("/"));
  const inside = path.relative(base, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  return target;
};

const aliasOf = (reference: string): string => {
  const separator = reference.indexOf(":");
  return separator >= 0 ? reference.slice(0, separator).toLowerCase() : "";
};

const configuredRoot = (reference: string, roots: ScopeRoot[]): ScopeRoot | undefined => {
  const alias = aliasOf(reference);
  return alias ? roots.find((root) => root.alias.toLowerCase() === alias) : undefined;
};

/** 查找候选文件的基准目录：配置根 + 计划文件所在目录及其上层（评审常以模块目录为基准引用文件）。 */
const lookupBases = (roots: ScopeRoot[], plannedFiles: string[]): ScopeRoot[] => {
  const bases: ScopeRoot[] = [...roots];
  const seen = new Set(bases.map((base) => path.resolve(base.path).toLowerCase()));
  for (const planned of plannedFiles) {
    const separator = planned.indexOf(":");
    const alias = separator >= 0 ? planned.slice(0, separator) : "project";
    const relative = (separator >= 0 ? planned.slice(separator + 1) : planned).replace(/\\/g, "/");
    const root = roots.find((item) => item.alias.toLowerCase() === alias.toLowerCase());
    if (!root) continue;
    let dir = path.posix.dirname(relative);
    for (let depth = 0; depth < 3; depth += 1) {
      if (!dir || dir === "." || dir === "/") break;
      const absolute = safeResolve(root.path, dir);
      if (absolute && !seen.has(absolute.toLowerCase())) {
        seen.add(absolute.toLowerCase());
        bases.push({ alias: root.alias, path: absolute });
      }
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return bases;
};

/** 把评审引用解析为「根别名:相对路径」。无别名时要求文件真实存在，且只接受唯一解。 */
export const resolveReviewReference = (
  raw: string,
  roots: ScopeRoot[],
  plannedFiles: string[],
): { file: string; absolute: string } | undefined => {
  const reference = normalizeReference(raw);
  if (!reference) return undefined;
  const separator = reference.indexOf(":");
  const alias = separator >= 0 ? reference.slice(0, separator) : "";
  const relative = separator >= 0 ? reference.slice(separator + 1) : reference;
  if (alias) {
    const root = configuredRoot(reference, roots);
    if (!root) return undefined;
    const absolute = safeResolve(root.path, relative);
    return absolute ? { file: `${root.alias}:${relative}`, absolute } : undefined;
  }
  if (!hasExtension(relative)) return undefined;
  const matches = new Map<string, { file: string; absolute: string }>();
  for (const base of lookupBases(roots, plannedFiles)) {
    const absolute = safeResolve(base.path, relative);
    if (!absolute || !fs.existsSync(absolute)) continue;
    const root = roots.find((item) => item.alias.toLowerCase() === base.alias.toLowerCase());
    if (!root) continue;
    // 命中目录可能只是根的子目录，必须以配置根为基准还原相对路径。
    const rootRelative = path.relative(path.resolve(root.path), absolute).replace(/\\/g, "/");
    if (!rootRelative || rootRelative.startsWith("..")) continue;
    const file = `${root.alias}:${rootRelative}`;
    matches.set(file.toLowerCase(), { file, absolute });
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
};

interface ReferenceEntry {
  raw: string;
  /** file = 结构化位置；action = 必须修正项；evidence = 评审举证。 */
  source: "file" | "action" | "evidence";
  declaredNew: boolean;
}

const referencesIn = (text: string, roots: ScopeRoot[]): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(ALIASED_PATH)) {
    const alias = match[1].toLowerCase();
    if (roots.some((root) => root.alias.toLowerCase() === alias)) found.push(`${match[1]}:${match[2]}`);
  }
  for (const match of text.matchAll(PLAIN_PATH)) found.push(match[0]);
  return found;
};

/** 收集阻断性 finding（high/medium）指向的文件引用和评审举证中出现的路径。 */
const collectReferences = (review: ReviewResult, roots: ScopeRoot[]): ReferenceEntry[] => {
  const entries: ReferenceEntry[] = [];
  for (const finding of review.findings) {
    if (finding.severity === "low") continue;
    const declaredNew = NEW_FILE_HINT.test(`${finding.title}\n${finding.required_action}`);
    const named = normalizeReference(finding.file);
    if (named) entries.push({ raw: named, source: "file", declaredNew });
    for (const reference of referencesIn(finding.required_action, roots)) {
      entries.push({ raw: reference, source: "action", declaredNew });
    }
    for (const reference of referencesIn(finding.evidence, roots)) {
      entries.push({ raw: reference, source: "evidence", declaredNew });
    }
  }
  const unique = new Map<string, ReferenceEntry>();
  for (const entry of entries) {
    const key = entry.raw.toLowerCase();
    const previous = unique.get(key);
    if (!previous || previous.source === "evidence") unique.set(key, entry);
  }
  return [...unique.values()];
};

const inPlannedScope = (reference: string, plannedFiles: string[]): boolean =>
  assessPlannedScope([normalizeReference(reference)], plannedFiles).ok;

/** 上限校验复用既有范围补充机制：总量不得超过 quality.max_changed_files，且不得改动原计划。 */
const validateAdditions = (
  investigation: InvestigationResult,
  additions: string[],
  limit: number,
): string => {
  if (!additions.length) return "";
  try {
    validateAmendedScope(
      investigation,
      { ...investigation, planned_files: [...investigation.planned_files, ...additions] },
      additions,
      limit,
    );
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** 把 P4 depot 形态的改动路径还原成根内相对路径：用配置根的本地路径尾部对齐 depot 片段。 */
export const depotToRootRelative = (depot: string, rootPath: string): string | undefined => {
  const normalized = depot.replace(/\\/g, "/").replace(/^[A-Za-z][A-Za-z0-9_]*:/, "");
  if (!normalized.startsWith("//")) return normalized.replace(/^\/+/, "");
  const segments = path.resolve(rootPath).replace(/\\/g, "/").replace(/\/$/, "").split("/").filter(Boolean);
  for (let take = Math.min(segments.length, 6); take >= 1; take -= 1) {
    const needle = `/${segments.slice(segments.length - take).join("/")}/`;
    const index = normalized.toLowerCase().lastIndexOf(needle.toLowerCase());
    if (index >= 0) return normalized.slice(index + needle.length);
  }
  return undefined;
};

/** 把 Agent 实际写出的文件归属回配置根内的相对路径（Git 根已是相对路径，P4 根可能是 depot 路径）。 */
export const relocateWrittenFile = (
  value: string,
  roots: ScopeRoot[],
): { file: string; relative: string; absolute: string } | undefined => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return undefined;
  const separator = normalized.indexOf(":");
  const alias = separator >= 0 ? normalized.slice(0, separator) : "project";
  const root = roots.find((item) => item.alias.toLowerCase() === alias.toLowerCase());
  if (!root) return undefined;
  const raw = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const relative = depotToRootRelative(raw, root.path);
  if (!relative) return undefined;
  const absolute = safeResolve(root.path, relative);
  if (!absolute) return undefined;
  return { file: `${root.alias}:${relative}`, relative, absolute };
};

/** 比较时只看根别名之后的路径部分：project://depot/.../A.ts 与 project:View/A.ts 属于同一文件的不同写法。 */
const pathPart = (value: string): string => {
  const normalized = normalizeReference(value).toLowerCase();
  const separator = normalized.indexOf(":");
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
};

const referenceMatchesFile = (reference: string, actual: string): boolean => {
  const expected = pathPart(reference);
  const candidate = pathPart(actual);
  if (!expected || !candidate) return false;
  return candidate === expected
    || candidate.endsWith(`/${expected}`)
    || path.posix.basename(candidate) === path.posix.basename(expected);
};

/**
 * correction 之前调用：把评审明确指向、且可安全解析的计划外文件加入本次有效范围。
 * 无法安全批准（显式根别名但不存在/越界、或超出文件上限）的要求返回在 unapprovable。
 */
export function reviewScopeAmendment(
  review: ReviewResult,
  roots: ScopeRoot[],
  investigation: InvestigationResult,
  limit: number,
): ReviewScopeAmendment {
  if (review.approved || !investigation.ok) return { ...EMPTY_AMENDMENT };
  const entries = collectReferences(review, roots);
  if (!entries.length) return { ...EMPTY_AMENDMENT };
  const approved: string[] = [];
  const unapprovable: string[] = [];
  const unresolved: string[] = [];
  let reason = "";
  for (const entry of entries) {
    if (inPlannedScope(entry.raw, investigation.planned_files)) continue;
    const resolved = resolveReviewReference(entry.raw, roots, investigation.planned_files);
    if (!resolved) {
      // 显式写了已配置根别名却定位不到（不存在/越界/非具体文件）＝无法安全批准的要求；
      // 其它仓库或无别名且无法定位的引用只是举证，不参与门禁。
      if (entry.source !== "evidence" && configuredRoot(entry.raw, roots)) unapprovable.push(entry.raw);
      else unresolved.push(entry.raw);
      continue;
    }
    if (!fs.existsSync(resolved.absolute)) {
      if (entry.declaredNew) {
        if (approved.some((file) => file.toLowerCase() === resolved.file.toLowerCase())) continue;
        approved.push(resolved.file);
        continue;
      }
      if (entry.source === "evidence") unresolved.push(entry.raw);
      else unapprovable.push(entry.raw);
      continue;
    }
    if (approved.some((file) => file.toLowerCase() === resolved.file.toLowerCase())) continue;
    approved.push(resolved.file);
  }
  const validation = validateAdditions(investigation, approved, limit);
  if (validation) {
    unapprovable.push(...approved);
    approved.length = 0;
    reason = validation;
  }
  return { requested: entries.map((entry) => entry.raw), approved, unapprovable, unresolved, reason };
}

/**
 * correction 结果之后调用：只针对 Agent 已实际写入、且被评审明确指名的计划外文件扩围。
 * 没有评审指向的多余改动不会被批准，范围门禁照旧拒绝。
 */
export function reviewScopeAmendmentForWritten(
  review: ReviewResult,
  roots: ScopeRoot[],
  investigation: InvestigationResult,
  limit: number,
  writtenFiles: string[],
): ReviewScopeAmendment {
  if (review.approved || !investigation.ok || !writtenFiles.length) return { ...EMPTY_AMENDMENT };
  const unplanned = assessPlannedScope(writtenFiles, investigation.planned_files).unplanned_files;
  if (!unplanned.length) return { ...EMPTY_AMENDMENT };
  const entries = collectReferences(review, roots);
  if (!entries.length) return { ...EMPTY_AMENDMENT };
  const approved: string[] = [];
  const unapprovable: string[] = [];
  const unresolved: string[] = [];
  let reason = "";
  for (const actual of unplanned) {
    const matching = entries.filter((entry) => referenceMatchesFile(entry.raw, actual));
    if (!matching.length) continue; // 没有评审指向的越界改动：保持原范围门禁
    const located = relocateWrittenFile(actual, roots);
    const locatedExists = Boolean(located && fs.existsSync(located.absolute));
    const resolved = locatedExists
      ? located
      : matching
        .map((entry) => resolveReviewReference(entry.raw, roots, investigation.planned_files))
        .find((item): item is { file: string; absolute: string } =>
          Boolean(item && fs.existsSync(item.absolute) && referenceMatchesFile(item.file, actual)));
    if (!resolved) {
      // 评审指向了该越界文件，但无法把它安全归属到配置根内的具体文件 → 交人工。
      unapprovable.push(actual);
      continue;
    }
    if (approved.some((file) => file.toLowerCase() === resolved.file.toLowerCase())) continue;
    approved.push(resolved.file);
  }
  const validation = validateAdditions(investigation, approved, limit);
  if (validation) {
    unapprovable.push(...approved);
    approved.length = 0;
    reason = validation;
  }
  return { requested: entries.map((entry) => entry.raw), approved, unapprovable, unresolved, reason };
}
