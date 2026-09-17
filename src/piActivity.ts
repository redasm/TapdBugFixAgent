/** Stream metadata only: never log private reasoning, prompts or credentials. */
export class PiActivity {
  private lastEventAt: number;
  private firstResponseAt?: number;
  private state = "等待模型响应";
  private thinkingChars = 0;
  private textChars = 0;
  private tools = 0;

  constructor(private readonly startedAt = Date.now()) { this.lastEventAt = startedAt; }

  observe(event: Record<string, any>, now = Date.now()): void {
    this.lastEventAt = now;
    const delta = event.assistantMessageEvent;
    if (event.type === "turn_start") this.state = "等待模型响应";
    if (event.type === "message_update" && delta) {
      this.firstResponseAt ??= now;
      if (String(delta.type).startsWith("thinking_")) {
        this.state = "模型推理中";
        if (delta.type === "thinking_delta") this.thinkingChars += String(delta.delta ?? "").length;
      } else if (String(delta.type).startsWith("text_")) {
        this.state = "模型输出中";
        if (delta.type === "text_delta") this.textChars += String(delta.delta ?? "").length;
      } else if (String(delta.type).startsWith("toolcall_")) this.state = "生成工具参数";
    }
    if (event.type === "tool_execution_start") {
      this.tools++;
      this.state = `执行工具 ${String(event.toolName ?? "unknown").slice(0, 60)}`;
    }
    if (event.type === "tool_execution_end") this.state = "等待后续模型响应";
    if (event.type === "auto_retry_start") this.state = "模型接口自动重试中";
    if (event.type === "agent_end") this.state = "模型已结束，等待进程退出";
  }

  summary(now = Date.now()): string {
    const first = this.firstResponseAt === undefined ? "未收到" : `${Math.round((this.firstResponseAt - this.startedAt) / 1000)}s`;
    return `${this.state}；首个响应=${first}，距最近事件=${Math.round((now - this.lastEventAt) / 1000)}s，推理字符=${this.thinkingChars}，文本字符=${this.textChars}，工具调用=${this.tools}`;
  }
}
