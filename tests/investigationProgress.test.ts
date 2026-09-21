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

  it("keeps validation gaps out of the checkpoint and hands them to the continuation prompt", () => {
    // 空输出 = 结构化结果缺项：这些缺项属于“输出缺了什么”，不是业务未决问题
    const result = parseInvestigation("");
    expect(result.validation_errors.length).toBeGreaterThan(0);
    const checkpoint = captureInvestigationProgress("工具 read: Map.ts", result);
    expect(checkpoint.open_questions).toEqual([]);
    const prompt = buildInvestigationContinuationPrompt("TASK", checkpoint, result.validation_errors);
    expect(prompt).toContain("上一轮未通过校验的项");
    expect(prompt).toContain(result.validation_errors[0]);
    expect(prompt).toContain("不是工单缺少信息");
    // 未传 validation_errors 时不再出现该小节，避免把缺项伪装成业务问题
    const withoutGaps = buildInvestigationContinuationPrompt("TASK", checkpoint);
    expect(withoutGaps).not.toContain("上一轮未通过校验的项");
  });

  it("carries verification limitations through the checkpoint instead of dropping them", () => {
    const raw = JSON.stringify({
      root_cause: "标记绘制条件错误",
      evidence: ["[观察] Map.ts:60 路径比较", "[推断] 路径不能代表地图身份"],
      planned_files: ["Map.ts"],
      reproduction: { command: "", before: "截图中标记消失" },
      verification_limitations: ["无法运行游戏，仅有截图与日志证据"],
    });
    const checkpoint = captureInvestigationProgress("工具 read: Map.ts", parseInvestigation(raw));
    expect(checkpoint.verification_limitations?.join(" ")).toContain("无法运行游戏");
    const carried = captureInvestigationProgress("工具 read: Click.ts", parseInvestigation(""), checkpoint);
    expect(carried.verification_limitations?.join(" ")).toContain("无法运行游戏");
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
    // 首个事件之前不得声称已在等模型响应：pi 是否发出请求尚未确认
    expect(activity.summary(30000)).toContain("等待 Pi 首个事件（模型请求是否发出尚未确认）");
    expect(activity.summary(30000)).toContain("已解析事件=0");
    activity.observe({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } }, 35000);
    expect(activity.summary(40000)).toContain("模型推理中；首个响应=35s");
    expect(activity.summary(40000)).toContain("推理字符=6");
    expect(activity.summary(40000)).not.toContain("secret");
    activity.observe({ type: "tool_execution_start", toolName: "read", args: { path: "private" } }, 42000);
    expect(activity.summary(70000)).toContain("执行工具 read");
    expect(activity.summary(70000)).toContain("距最近事件=28s");
    expect(activity.summary(70000)).toContain("已解析事件=2");
    expect(activity.summary(70000)).not.toContain("private");
  });

  it("非 turn_start 的首个事件后不再停留在「等待首个事件」，且不声称请求已发出", () => {
    const activity = new PiActivity(0);
    // session / agent_start / 未知类型：只能确认 pi 有输出，不能确认模型请求已发出
    activity.observe({ type: "session", id: "s1" }, 1000);
    const afterSession = activity.summary(1000);
    expect(afterSession).toContain("Pi 已输出事件，等待模型响应（请求是否已发出未确认）");
    expect(afterSession).not.toContain("等待 Pi 首个事件");
    expect(afterSession).toContain("已解析事件=1");
    expect(afterSession).toContain("首个响应=未收到");
    expect(activity.parsedEvents).toBe(1);
    // turn_start 之后进入等待模型响应，但不得声称 HTTP 请求已经发出
    activity.observe({ type: "turn_start" }, 2000);
    const afterTurn = activity.summary(2000);
    expect(afterTurn).toContain("等待模型响应（请求是否已发出未确认）");
    expect(afterTurn).toContain("已解析事件=2");
    expect(afterTurn).not.toMatch(/HTTP|已发送|请求已发出/);
    // 后续未识别事件不得把状态退回「等待首个事件」
    activity.observe({ type: "unknown_heartbeat" }, 3000);
    expect(activity.summary(3000)).toContain("等待模型响应（请求是否已发出未确认）");
    expect(activity.summary(3000)).toContain("已解析事件=3");
  });
});
