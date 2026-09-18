import { describe, it, expect } from "vitest";
import { StateStore } from "../src/state.js";
import { bugFromDict } from "../src/models.js";

const bug = bugFromDict({ id: "1123456780001273338", title: "跨地图传送" }, "111");
const patch = "--- old\n+++ new\n@@ -1 +1 @@\n-path\n+mapId\n";
function setup() {
  const store = new StateStore(":memory:");
  store.upsertJob(bug);
  const begin = () => store.audit.begin({ bug_id: bug.id, workspace_id: "111", input: { title: bug.title }, metadata: { model: "test" } });
  const candidate = (id: string, delivery: "complete" | "partial" = "complete") => store.audit.candidate(id, { diff: patch, files: ["Map.ts"], delivery, evidence: {} });
  const feedback = (id: string, outcome: "accepted_unchanged" | "accepted_modified" | "reopened" = "accepted_unchanged") => store.recordFeedback(bug.id, {
    candidate_id: id, outcome, reason: "测试", human_changed_lines: null, submitted_changelist: null,
  });
  return { store, begin, candidate, feedback };
}

describe("candidate provenance", () => {
  it("preserves immutable attempts and feedback through retries and resync", () => {
    const { store, begin, candidate, feedback } = setup();
    const first = begin(), cid = candidate(first);
    store.audit.event(first, "finished", { state: "candidate" });
    feedback(cid);
    const second = begin();
    store.updateJob(bug.id, { agent_state: "in_progress" });
    feedback(cid, "reopened");
    expect(store.getJob(bug.id)?.agent_state).toBe("in_progress");
    expect(() => store.audit.event(first, "patch", {})).toThrow("已结束");
    store.audit.event(second, "finished", { state: "failed" });
    store.deleteAllJobs();
    expect(store.audit.attempts()).toHaveLength(2);
    expect(store.audit.candidates()).toHaveLength(1);
    expect(store.audit.feedback()).toHaveLength(2);
    expect(store.qualityMetrics().candidates).toMatchObject({ inputs: 1, attempts: 2, end_to_end_effective_rate: 0 });
    store.close();
  });

  it("does not count partial/no-output attempts as full candidates and reports unknown costs", () => {
    const { store, begin, candidate, feedback } = setup();
    const id = begin();
    const cid = candidate(id, "partial");
    store.audit.event(id, "finished", { state: "failed" });
    feedback(cid, "accepted_modified");
    expect(store.audit.metrics()).toMatchObject({ complete_candidates: 0, partial_candidates: 1, candidate_precision: null, end_to_end_effective_rate: 0, model_cost: null });
    expect(store.audit.feedback()[0].human_changed_lines).toBeNull();
    store.close();
  });

  it("requires explicit candidate identity and rejects cross-bug/reopen misuse atomically", () => {
    const { store, begin, candidate, feedback } = setup();
    const missingCandidate = { candidate_id: "", outcome: "accepted_unchanged" as const, reason: "", human_changed_lines: null, submitted_changelist: null };
    expect(() => store.recordFeedback(bug.id, missingCandidate)).toThrow("具体候选");
    const id = begin(), cid = candidate(id);
    expect(() => store.recordFeedback(bug.id, { candidate_id: "", outcome: "accepted_unchanged", reason: "", human_changed_lines: null, submitted_changelist: null })).toThrow("具体候选");
    expect(() => feedback("wrong-candidate")).toThrow("不属于");
    expect(() => feedback(cid, "reopened")).toThrow("已经接受");
    expect(store.audit.feedback()).toHaveLength(0);
    store.close();
  });

  it("rejects non-patches, records hashes, and observes a fixed follow-up window", () => {
    const { store, begin, candidate, feedback } = setup();
    const id = begin();
    expect(() => store.audit.candidate(id, { diff: "--- old\n+++ new", files: ["Map.ts"], delivery: "complete", evidence: {} })).toThrow("非空补丁");
    const cid = candidate(id);
    store.audit.event(id, "finished", { state: "candidate" });
    feedback(cid);
    expect(store.audit.metrics().sustained_fix_rate).toBeNull();
    const future = new Date(Date.now() + 15 * 86400000);
    expect(store.audit.metrics({ now: future }).sustained_fix_rate).toBe(1);
    feedback(cid, "reopened");
    expect(store.audit.metrics({ now: future }).sustained_fix_rate).toBe(0);
    expect(store.audit.candidates()[0].diff_hash).toHaveLength(64);
    store.close();
  });
});
