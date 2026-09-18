import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { StateStore } from "../src/state.js";
import { bugFromDict } from "../src/models.js";
import { feedbackMemories } from "../src/feedbackMemory.js";
import { createApp } from "../src/web/app.js";
import type { Config } from "../src/config.js";
import type { Worker } from "../src/worker.js";

const bug = bugFromDict({ id: "1123456780001273338", title: "跨地图传送" }, "111");
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const candidateFor = (store: StateStore) => {
  const attempt = store.audit.begin({ bug_id: bug.id, workspace_id: bug.workspace_id, input: bug, metadata: {} });
  const candidate = store.audit.candidate(attempt, { diff: "-old\n+fixed\n", files: ["Map.ts"], delivery: "complete", evidence: {} });
  store.audit.event(attempt, "finished", { state: "review_pending" });
  return candidate;
};
describe("current feedback protocol", () => {
  it("keeps historical labels unchanged and writes new feedback only to its candidate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-feedback-"));
    dirs.push(dir);
    const file = path.join(dir, "state.db");
    const initial = new StateStore(file);
    initial.upsertJob(bug);
    initial.close();
    const seed = new Database(file);
    seed.prepare("INSERT INTO job_feedback(bug_id,outcome,reason,human_changed_lines,submitted_changelist,created_at) VALUES (?,?,?,?,?,?)")
      .run(bug.id, "rejected_wrong_root_cause", "传送条件需核对地图 ID", 0, null, "2026-09-17 10:00:00");
    seed.close();
    const store = new StateStore(file);
    try {
      const original = store.listHistoricalFeedback();
      const baseline = store.qualityMetrics().historical;
      expect(baseline).toMatchObject({ reviewed: 1, rejected: 1, candidate_precision: 0 });
      expect(feedbackMemories(store)[0]).toMatchObject({ outcome: "rejected_wrong_root_cause", status: "human_feedback_requires_code_check" });
      store.recordFeedback(bug.id, { candidate_id: candidateFor(store), outcome: "accepted_unchanged", reason: "已修复", human_changed_lines: 0, submitted_changelist: 123 });
      expect(store.listHistoricalFeedback()).toEqual(original);
      expect(store.qualityMetrics().historical).toEqual(baseline);
      expect(store.audit.feedback()).toHaveLength(1);
      expect(store.qualityMetrics().candidates).toMatchObject({ reviewed: 1, accepted_unchanged: 1, candidate_precision: 1 });
    } finally { store.close(); }
  });

  it("rejects unbound HTTP requests and returns separate historical and candidate metrics", async () => {
    vi.stubEnv("WEB_TOKEN", "");
    const store = new StateStore(":memory:");
    store.upsertJob(bug, { changelist: 123, agent_state: "review_pending" });
    const app = createApp({ web: { token: "" } } as Config, store, {} as Worker);
    const server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/api/bugs/${bug.id}/feedback`;
    const body = { outcome: "accepted_unchanged", reason: "测试", human_changed_lines: null, submitted_changelist: null };
    const post = (value: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    try {
      const old = await post(body);
      expect(old.status).toBe(400);
      expect((await old.json()).detail).toContain("具体候选");
      expect(store.audit.feedback()).toEqual([]);
      const candidate_id = candidateFor(store);
      const invalid = await post({ ...body, candidate_id: 123 });
      expect(invalid.status).toBe(400);
      await invalid.json();
      const current = await post({ ...body, candidate_id });
      expect(current.status).toBe(200);
      expect((await current.json()).metrics).toMatchObject({
        historical: { reviewed: 0 }, candidates: { reviewed: 1, accepted_unchanged: 1 },
      });
      expect(store.listHistoricalFeedback()).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });
});
