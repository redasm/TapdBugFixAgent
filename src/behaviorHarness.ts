/** Execute actual TypeScript members with explicit external dependency doubles. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

export function loadTypeScriptMembers(root: string, relative: string, className: string, members: string[], dependencies: Record<string, unknown> = {}): any {
  const base = fs.realpathSync(root);
  const file = fs.realpathSync(path.resolve(base, relative));
  const rel = path.relative(base, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("测试源码必须位于目标根目录中");
  const source = fs.readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let target: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) target = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!target) throw new Error(`未找到实际类 ${className}`);
  const selected = target.members.filter(m => m.name && members.includes(m.name.getText(ast)));
  if (selected.length !== members.length) throw new Error(`实际源码缺少测试成员: ${members.join(", ")}`);
  const code = `class Subject {\n${selected.map(m => m.getText(ast)).join("\n")}\n}`;
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const Subject = vm.runInNewContext(`${js}\nSubject`, dependencies, { timeout: 1000 });
  return new Subject();
}
