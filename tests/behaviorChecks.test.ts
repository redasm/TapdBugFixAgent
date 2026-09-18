import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { assessBehaviorResults, prepareBehaviorChecks, verifyBehaviorChecks } from "../src/behaviorChecks.js";

describe("frozen behavior verification", () => {
  it("executes the real TS method before and after, retaining the original assertions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-test-"));
    const suite = path.join(root, "suite.mjs");
    const source = path.join(root, "Map.ts");
    try {
      fs.writeFileSync(source, "export class Map { canTravel(playerId: number, targetId: number) { return true; } }");
      fs.writeFileSync(suite, `export const files = ['Map.ts'];
      export default async ({ test, assert, loadMembers }) => {
        const actual = loadMembers(files[0],'Map',['canTravel'],{});
        await test('cross-map', 'reproduction', () => assert.equal(actual.canTravel(1,2),false));
        await test('same-map', 'regression', () => assert.equal(actual.canTravel(1,1),true));
      };`);
      const frozen = await prepareBehaviorChecks({ enabled: true, directory: root, disabled: [], timeout_sec: 30 }, root, ["project:Map.ts"]);
      expect(frozen[0].before.map(r => r.status)).toEqual(["fail", "pass"]);
      fs.writeFileSync(source, "export class Map { canTravel(playerId: number, targetId: number) { return playerId === targetId; } }");
      fs.writeFileSync(suite, "throw Error('candidate modified test file');");
      expect(await verifyBehaviorChecks(frozen, root)).toMatchObject({ ok: true, reproduced: true, level: "L1" });
      fs.writeFileSync(source, "export class Map { canTravel(playerId: number, targetId: number) { return false; } }");
      expect(await verifyBehaviorChecks(frozen, root)).toMatchObject({ ok: false, level: "L0" });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("does not count environment failures or static checks as reproduction", () => {
    expect(assessBehaviorResults([])).toMatchObject({ level: "L0", reproduced: false });
    const error = { id: "load", kind: "reproduction" as const, status: "error" as const, detail: "missing UE" };
    expect(assessBehaviorResults([{ name: "runtime", suite_hash: "hash", before: [error], after: [error] }])).toMatchObject({ level: "L0", reproduced: false });
    expect(assessBehaviorResults([{ name: "runtime", suite_hash: "hash", before: [{ ...error, status: "fail" }], after: [{ ...error, id: "different", status: "pass" }] }]).ok).toBe(false);
    expect(assessBehaviorResults([{ name: "without-normal-control", suite_hash: "hash", before: [{...error,status:"fail"}], after:[{...error,status:"pass"}] }])).toMatchObject({level:"L0",reproduced:true});
  });
});
