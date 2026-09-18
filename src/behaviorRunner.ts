/** Child process protocol. Frozen suite imports only built-ins; target code is read via the harness. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { loadTypeScriptMembers } from "./behaviorHarness.js";

const [suiteFile, root] = process.argv.slice(2);
const results: Array<{ id: string; kind: "reproduction" | "regression"; status: "pass" | "fail" | "error"; detail: string }> = [];
try {
  const source = fs.readFileSync(suiteFile, "utf8");
  const suite = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  await suite.default({ root, assert, loadMembers: (file: string, name: string, members: string[], deps: Record<string, unknown>) => loadTypeScriptMembers(root, file, name, members, deps),
    test: async (id: string, kind: "reproduction" | "regression", run: () => unknown) => {
      try { await run(); results.push({ id, kind, status: "pass", detail: "" }); }
      catch (error) { results.push({ id, kind, status: error instanceof assert.AssertionError ? "fail" : "error", detail: String(error) }); }
    },
  });
  process.stdout.write(`\nBEHAVIOR_RESULT:${JSON.stringify(results)}\n`);
} catch (error) {
  process.stdout.write(`\nBEHAVIOR_RESULT:${JSON.stringify([{ id: "suite-load", kind: "regression", status: "error", detail: String(error) }])}\n`);
  process.exitCode = 2;
}
