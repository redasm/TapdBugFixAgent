import { describe, expect, it } from "vitest";
import { captureInvestigationProgress, compactInvestigationTrace } from "../src/investigationProgress.js";
import { buildInvestigationContinuationPrompt, buildInvestigationTimeoutRecoveryPrompt, parseInvestigation } from "../src/repairWorkflow.js";
import { piRecoveryTrace } from "../src/agent.js";
import { PiActivity } from "../src/piActivity.js";

describe("investigation continuity", () => {
  it("retains original tool evidence when a formatter returns incomplete findings", () => {
    const original = captureInvestigationProgress('工具 read: {"path":"Map.ts","offset":40}\n结果 read: enterPlacement();', parseInvestigation(""));
    const partial = JSON.stringify({ evidence: ["[观察] Map.ts:40 调用 enterPlacement"], blocked_reasons: ["未证实边缘点击是否调用 enterPlacement"] });
    const checkpoint = captureInvestigationProgress(partial, parseInvestigation(partial), original);
    expect(checkpoint.tool_calls).toHaveLength(1);
    expect(checkpoint.trace).toContain("结果 read: enterPlacement();");
    expect(checkpoint.open_questions.join(" ")).toContain("未证实边缘点击");
    const prompt = buildInvestigationContinuationPrompt("TASK\n# 上次失败证据\n" + "OLD".repeat(30000), checkpoint);
    expect(prompt).toContain("当前仍是只读阶段");
    expect(prompt).toContain("enterPlacement");
    expect(prompt).not.toContain("OLD");
    const timedOut = captureInvestigationProgress("工具 read: Click.ts", parseInvestigation(""), checkpoint);
    expect(timedOut.open_questions.join(" ")).toContain("未证实边缘点击");
  });

  it("formatter excludes recursive retry prompts and bounds trace while keeping entry and tail", () => {
    const trace = "FIRST_EVIDENCE" + "x".repeat(40000) + "LAST_EVIDENCE";
    const task = "# Bug 上下文\nbug123\n# 工作目录\nproject: C:/repo\n# 版本控制与只读命令规则\nRULES\n# 上次失败证据\n" + "OLD_RETRY".repeat(8000);
    const prompt = buildInvestigationTimeoutRecoveryPrompt(task, trace);
    expect(prompt.length).toBeLessThan(20000);
    expect(prompt).toContain("bug123");
    expect(prompt).toContain("FIRST_EVIDENCE");
    expect(prompt).toContain("LAST_EVIDENCE");
    expect(prompt).not.toContain("OLD_RETRY");
    expect(compactInvestigationTrace(trace).length).toBeLessThanOrEqual(18000);
  });

  it("retains unfinished text deltas on timeout without recording reasoning or prompt examples", () => {
    const trace = piRecoveryTrace([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_REASONING" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已读 Map.ts；待核查 OnClick" } },
    ].map((event) => JSON.stringify(event)));
    expect(trace).toContain("已读 Map.ts；待核查 OnClick");
    expect(trace).not.toContain("PRIVATE_REASONING");
  });
});

describe("Pi stream diagnostics", () => {
  it("distinguishes waiting, reasoning and tool execution with metadata only", () => {
    const activity = new PiActivity(0);
    expect(activity.summary(30000)).toContain("首个响应=未收到");
    activity.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } }, 35000);
    expect(activity.summary(40000)).toContain("模型推理中；首个响应=35s");
    expect(activity.summary(40000)).toContain("推理字符=6");
    expect(activity.summary(40000)).not.toContain("secret");
    activity.observe({ type: "tool_execution_start", toolName: "read", args: { path: "private" } }, 42000);
    expect(activity.summary(70000)).toContain("执行工具 read");
    expect(activity.summary(70000)).toContain("距最近事件=28s");
    expect(activity.summary(70000)).not.toContain("private");
  });
});
