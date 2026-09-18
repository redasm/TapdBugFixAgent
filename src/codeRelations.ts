import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { evidenceHash } from "./attemptAudit.js";

const skip = new Set(["node_modules", ".git", "dist", "Binaries", "Intermediate", "Saved"]);
const cache = new Map<string, { hash: string; source: ts.SourceFile }>();

/** Bounded AST navigation. Identifier matches are candidates, not resolved dynamic calls. */
export function codeRelations(root: string, directory: string, query: string, mode: "symbol" | "references" | "related", limit = 25) {
  if (!query.trim()) throw new Error("必须提供符号名");
  const base = fs.realpathSync(root), start = fs.realpathSync(path.resolve(base,directory));
  const inside = (file: string) => { const rel=path.relative(base,file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  if (!inside(start)) throw new Error("符号检索目录超出工作区");
  const deadline = Date.now()+2000, pending=[start];
  const results: Array<{ file: string; line: number; symbol: string; kind: string; snippet: string; source_hash: string }> = [];
  let scanned=0,truncated=false;
  limit=Math.max(1,Math.min(50,Number.isFinite(limit)?limit:25));
  while (pending.length && Date.now()<deadline && scanned<300 && results.length<limit) {
    const file=pending.pop()!, stat=fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { for(const name of fs.readdirSync(file).sort().reverse())if(!skip.has(name))pending.push(path.join(file,name));continue; }
    if (!/\.[cm]?tsx?$/.test(file) || stat.size>1024*1024) continue;
    scanned++;
    const text=fs.readFileSync(file,"utf8"),hash=evidenceHash(text);
    let item=cache.get(file);
    if(!item || item.hash!==hash){item={hash,source:ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)};cache.set(file,item);}
    if(cache.size>300)cache.delete(cache.keys().next().value!);
    const source=item.source;
    const visit=(node:ts.Node)=>{
      if(results.length>=limit){truncated=true;return;}
      if(ts.isIdentifier(node)){
        const parent=node.parent as ts.NamedDeclaration;
        const declaration=parent.name===node && (ts.isClassDeclaration(parent)||ts.isMethodDeclaration(parent)||ts.isFunctionDeclaration(parent)||ts.isPropertyDeclaration(parent)||ts.isInterfaceDeclaration(parent));
        const matches=mode==="related" ? declaration && node.text.toLowerCase().includes(query.toLowerCase()) : node.text===query && (mode==="references" || declaration);
        if(matches){const line=source.getLineAndCharacterOfPosition(node.getStart(source)).line;
          results.push({file:path.relative(base,file).replace(/\\/g,"/"),line:line+1,symbol:node.text,kind:declaration?ts.SyntaxKind[parent.kind]:"identifier_candidate",snippet:text.split(/\r?\n/).slice(Math.max(0,line-1),line+3).join("\n").slice(0,900),source_hash:hash});}
      }
      ts.forEachChild(node,visit);
    };
    visit(source);
  }
  return {results,scanned_files:scanned,truncated:truncated||pending.length>0,
    limitation:"AST 声明/标识符候选；未解析跨文件类型身份、蓝图、反射或动态派发。须读取调用点核实；截断时不能据此排除。"};
}
