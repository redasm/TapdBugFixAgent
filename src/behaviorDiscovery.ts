/** Discover suite metadata without executing test modules in the worker process. */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface BehaviorChecksConfig {
  enabled: boolean;
  directory: string;
  disabled: string[];
  timeout_sec: number;
}

export interface DiscoveredBehaviorSuite {
  name: string;
  source: string;
  files: string[];
  timeout_sec: number;
}

export function parseBehaviorConfig(value: unknown, configDir: string): BehaviorChecksConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("behavior_checks 须为目录配置对象，不再支持逐文件列表");
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["enabled", "directory", "disabled", "timeout_sec"].includes(key))) {
    throw new Error("behavior_checks 只支持 enabled、directory、disabled、timeout_sec");
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("behavior_checks.enabled 须为布尔值");
  if (typeof raw.directory !== "string" || !raw.directory.trim()) throw new Error("behavior_checks.directory 须为测试目录");
  const disabled = raw.disabled ?? [];
  if (!Array.isArray(disabled) || disabled.some(name => typeof name !== "string" || !name.trim()
    || name.includes("\\") || name.includes(":") || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")
    || /[*?]/.test(name) || name.endsWith(".mjs"))) {
    throw new Error("behavior_checks.disabled 须为测试名数组（目录内相对路径，不含 .mjs）");
  }
  const timeout = raw.timeout_sec ?? 30;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("行为测试 timeout_sec 须为 1–300 秒");
  }
  const config = { enabled: raw.enabled ?? true, directory: path.resolve(configDir, raw.directory),
    disabled: [...new Set(disabled)], timeout_sec: timeout } as BehaviorChecksConfig;
  if (config.enabled && (!fs.existsSync(config.directory) || !fs.statSync(config.directory).isDirectory())) {
    throw new Error(`行为测试目录不存在: ${config.directory}`);
  }
  return config;
}

function suiteFiles(source: string, name: string): string[] {
  const ast = ts.createSourceFile(`${name}.mjs`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ast.statements.flatMap(statement => {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
      || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    return statement.declarationList.declarations.filter(d => ts.isIdentifier(d.name) && d.name.text === "files");
  });
  const value = declarations[0]?.initializer;
  if (declarations.length !== 1 || !value || !ts.isArrayLiteralExpression(value) || !value.elements.length
    || value.elements.some(element => !ts.isStringLiteral(element))) {
    throw new Error(`行为测试 ${name} 须声明 export const files = ["仓库相对路径", ...]，只支持非空字符串字面量数组`);
  }
  const files = value.elements.map(element => (element as ts.StringLiteral).text.replace(/\\/g, "/"));
  if (files.some(file => !file.trim() || file.startsWith("/") || /[:*?\0]/.test(file)
    || file.split("/").some(part => !part || part === "." || part === ".."))) {
    throw new Error(`行为测试 ${name} 的 files 须为具体仓库相对路径，不支持通配符或目录越界`);
  }
  return [...new Set(files)];
}

/** Rescan for each attempt. Returned source is frozen together with its metadata. */
export function discoverBehaviorSuites(config?: BehaviorChecksConfig): DiscoveredBehaviorSuite[] {
  if (!config?.enabled) return [];
  const disabled = new Set(config.disabled.map(name => name.toLowerCase()));
  const suites: DiscoveredBehaviorSuite[] = [];
  const names = new Set<string>();
  let entries = 0;
  const scan = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > 2000) throw new Error("行为测试目录超过2000项，请配置专用测试目录");
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const name = path.relative(config.directory, file).replace(/\\/g, "/").slice(0, -4);
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error(`行为测试名称重复: ${name}`);
      names.add(key);
      if (disabled.has(key)) continue;
      if (fs.statSync(file).size > 100000) throw new Error(`行为测试 ${name} 脚本超过100KB，须拆分为定向测试`);
      const source = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(source) > 100000) throw new Error(`行为测试 ${name} 脚本超过100KB，须拆分为定向测试`);
      suites.push({ name, source, files: suiteFiles(source, name), timeout_sec: config.timeout_sec });
    }
  };
  scan(config.directory);
  return suites;
}
