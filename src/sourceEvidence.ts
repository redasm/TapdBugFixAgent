import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** Content identity, including absent new files; never traverses outside configured roots. */
export function sourceEvidence(files: string[], roots: Array<{ alias: string; path: string }>) {
  return files.map(file => {
    const colon = file.indexOf(":");
    const alias = colon < 0 ? "project" : file.slice(0, colon);
    const relative = colon < 0 ? file : file.slice(colon + 1);
    const root = roots.find(r => r.alias.toLowerCase() === alias.toLowerCase());
    if (!root) return { file, error: "unknown_root" };
    try {
      const base = fs.realpathSync(root.path);
      const target = path.resolve(base, relative);
      const rel = path.relative(base, target);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw Error("outside_root");
      if (!fs.existsSync(target)) return { file, exists: false };
      const real = path.relative(base, fs.realpathSync(target));
      if (real.startsWith("..") || path.isAbsolute(real)) throw Error("outside_root");
      const content = fs.readFileSync(target);
      return { file, exists: true, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
    } catch (error) { return { file, error: String(error) }; }
  });
}

export function runtimeEvidence() {
  return Object.fromEntries(["agent", "worker", "repairWorkflow", "review", "verify", "behaviorChecks", "codeRelations"].map(name => {
    const js=fileURLToPath(new URL(`./${name}.js`,import.meta.url));
    const file=fs.existsSync(js)?js:js.replace(/\.js$/,".ts");
    return [name,createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  }));
}
