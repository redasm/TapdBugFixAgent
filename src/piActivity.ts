/** Stream metadata only: never log private reasoning, prompts or credentials. */
export class PiActivity {
  private lastEventAt: number;
  private firstResponseAt?: number;
  /** 首事件尚未到达：既不知道 pi 是否已启动模型请求，也不知道请求是否已发出。
   *  旧文案「等待模型响应」在这种情况下会把“本地/进程侧没动静”误报成“已在等模型”。 */
  private state = "等待 Pi 首个事件（模型请求是否发出尚未确认）";
  private thinkingChars = 0;
  private textChars = 0;
  private tools = 0;
  private events = 0;

  constructor(private readonly startedAt = Date.now()) { this.lastEventAt = startedAt; }

  /** 已解析的 JSONL 事件数（心跳诊断用；非 JSON 行不计入，也不代表模型已响应）。 */
  get parsedEvents(): number { return this.events; }

  observe(event: Record<string, any>, now = Date.now()): void {
    this.lastEventAt = now;
    this.events += 1;
    let described = false;
    const delta = event.assistantMessageEvent;
    if (event.type === "turn_start") { this.state = "等待模型响应（请求是否已发出未确认）"; described = true; }
    if (event.type === "message_update" && delta) {
      this.firstResponseAt ??= now;
      described = true;
      if (String(delta.type).startsWith("thinking_")) {
        this.state = "模型推理中";
        if (delta.type === "thinking_delta") this.thinkingChars += String(delta.delta ?? "").length;
      } else if (String(delta.type).startsWith("text_")) {
        this.state = "模型输出中";
        if (delta.type === "text_delta") this.textChars += String(delta.delta ?? "").length;
      } else if (String(delta.type).startsWith("toolcall_")) this.state = "生成工具参数";
      else described = false;
    }
    if (event.type === "tool_execution_start") {
      this.tools++;
      this.state = `执行工具 ${String(event.toolName ?? "unknown").slice(0, 60)}`;
      described = true;
    }
    if (event.type === "tool_execution_end") { this.state = "等待后续模型响应"; described = true; }
    if (event.type === "auto_retry_start") { this.state = "模型接口自动重试中"; described = true; }
    if (event.type === "agent_end") { this.state = "模型已结束，等待进程退出"; described = true; }
    // 第一个事件不足以说明状态（session/agent_start/未知类型等）时，必须从“等待首个事件”
    // 过渡到“已有事件、请求状态仍未确认”，否则首事件到达后文案会自相矛盾。
    if (this.events === 1 && !described) this.state = "Pi 已输出事件，等待模型响应（请求是否已发出未确认）";
  }

  summary(now = Date.now()): string {
    const first = this.firstResponseAt === undefined ? "未收到" : `${Math.round((this.firstResponseAt - this.startedAt) / 1000)}s`;
    return `${this.state}；首个响应=${first}，距最近事件=${Math.round((now - this.lastEventAt) / 1000)}s，已解析事件=${this.events}，推理字符=${this.thinkingChars}，文本字符=${this.textChars}，工具调用=${this.tools}`;
  }
}
