import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverBehaviorSuites, parseBehaviorConfig, type BehaviorChecksConfig } from "../src/behaviorDiscovery.js";
import { prepareBehaviorChecks, verifyBehaviorChecks } from "../src/behaviorChecks.js";
import { loadConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-discovery-"));
  roots.push(root);
  const directory = path.join(root, "suites");
  fs.mkdirSync(directory);
  const config: BehaviorChecksConfig = { enabled: true, directory, disabled: [], timeout_sec: 2 };
  const write = (name: string, files = ["Map.ts"]) => {
    const file = path.join(directory, `${name}.mjs`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `export const files = ${JSON.stringify(files)};
      export default async ({test,assert}) => {
        await test('normal', 'regression', () => assert.equal(files.length > 0, true));
      };`);
    return file;
  };
  return { root, directory, config, write };
}

describe("behavior directory discovery", () => {
  it("finds added suites, removed suites and metadata edits on each scan", () => {
    const { config, write } = setup();
    expect(discoverBehaviorSuites(config)).toEqual([]);
    const a = write("map/tiles");
    write("recruit", ["Recruit.ts", "Model.ts"]);
    expect(discoverBehaviorSuites(config).map(s => [s.name, s.files])).toEqual([
      ["map/tiles", ["Map.ts"]], ["recruit", ["Recruit.ts", "Model.ts"]],
    ]);
    write("recruit", ["Renamed.ts"]);
    fs.unlinkSync(a);
    expect(discoverBehaviorSuites(config).map(s => [s.name, s.files])).toEqual([["recruit", ["Renamed.ts"]]]);
  });

  it("skips disabled suites before parsing and supports a disabled missing directory", () => {
    const { config, write } = setup();
    const file = write("map/tiles");
    fs.writeFileSync(file, "throw new Error('disabled');");
    expect(discoverBehaviorSuites({ ...config, disabled: ["map/tiles"] })).toEqual([]);
    expect(discoverBehaviorSuites({ ...config, enabled: false, directory: "missing" })).toEqual([]);
    expect(discoverBehaviorSuites()).toEqual([]);
  });

  it("does not execute top-level code while discovering metadata", () => {
    const { root, config, write } = setup();
    const marker = path.join(root, "must-not-exist");
    const file = write("read-only");
    fs.appendFileSync(file, `\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    expect(discoverBehaviorSuites(config)[0].files).toEqual(["Map.ts"]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    "export const files = getFiles();",
    "const files = ['Map.ts'];",
    "export let files = ['Map.ts'];",
    "export const files = [];",
    "export const files = ['../Map.ts'];",
    "export const files = ['/Map.ts'];",
    "export const files = ['project:Map.ts'];",
    "export const files = ['Src/*.ts'];",
  ])("rejects malformed or unsafe metadata: %s", source => {
    const { config, write } = setup();
    fs.writeFileSync(write("invalid"), source);
    expect(() => discoverBehaviorSuites(config)).toThrow(/files|相对路径/);
  });

  it("ignores unrelated files and refuses oversized scripts", () => {
    const { directory, config, write } = setup();
    fs.writeFileSync(path.join(directory, "README.md"), "documentation");
    write(".hidden");
    expect(discoverBehaviorSuites(config)).toEqual([]);
    fs.writeFileSync(write("large"), " ".repeat(100001));
    expect(() => discoverBehaviorSuites(config)).toThrow("100KB");
  });

  it("selects any declared target, respects repo aliases and freezes deletion for the current attempt", async () => {
    const { root, config, write } = setup();
    const file = write("map", ["Map.ts", "Model.ts"]);
    expect(await prepareBehaviorChecks(config, root, ["engine:Map.ts", "Other.ts"])).toEqual([]);
    const frozen = await prepareBehaviorChecks(config, root, ["project:Model.ts"]);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({ name: "map", timeout_sec: 2, files: ["Map.ts", "Model.ts"] });
    fs.unlinkSync(file);
    expect((await verifyBehaviorChecks(frozen, root)).checks[0].after[0].status).toBe("pass");
    expect(await prepareBehaviorChecks(config, root, ["project:Model.ts"])).toEqual([]);
  });
});

describe("behavior directory configuration", () => {
  it("loads directory settings relative to config.yaml and rejects the old list protocol", () => {
    const { root, directory } = setup();
    const file = path.join(root, "config.yaml");
    const load = () => loadConfig(file, path.join(root, ".env"), path.join(root, "overrides.yaml"));
    fs.writeFileSync(file, JSON.stringify({ workspaces: [{ repos: [{ behavior_checks: {
      directory: "suites", disabled: ["map/tiles"], timeout_sec: 45,
    } }] }] }));
    expect(load().workspaces[0].repos[0].behavior_checks).toEqual({ enabled: true, directory, disabled: ["map/tiles"], timeout_sec: 45 });
    fs.writeFileSync(file, JSON.stringify({ workspaces: [{ repos: [{ behavior_checks: [] }] }] }));
    expect(load).toThrow("不再支持逐文件列表");
  });

  it("validates directory existence, timeout, disabled names and unknown keys", () => {
    const { root } = setup();
    expect(parseBehaviorConfig(undefined, root)).toBeUndefined();
    expect(() => parseBehaviorConfig({ directory: "missing" }, root)).toThrow("目录不存在");
    expect(parseBehaviorConfig({ enabled: false, directory: "missing" }, root)?.enabled).toBe(false);
    for (const raw of [{ directory: "suites", timeout_sec: 0 }, { directory: "suites", disabled: ["map.mjs"] },
      { directory: "suites", disabled: ["../map"] }, { directory: "suites", enabled: "false" }, { directory: "suites", files: [] }]) {
      expect(() => parseBehaviorConfig(raw, root)).toThrow();
    }
  });
});
