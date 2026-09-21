/** Coordinator 角色（只读、无工具、严格 JSON）的调用契约。
 *
 *  唯一职责边界（与 README「多 Agent 编排（角色层）」一致）：
 *  - 只在两处被调用：**主调查之前**产出「调查计划建议」，**最终交付之前**产出「最终汇总文案」。
 *    两处都是**可选调用点**：只有配置里出现 `agents.roles.coordinator` 时才启用
 *    （见 agentRoleEnabled），未配置时调用序列与改造前逐字一致。
 *  - 只读且无工具（`tools: []` + `sandbox read-only`）：看不到卡片外的任何东西，
 *    也不产生工具副作用；它拿到的上下文全部由编排器在 prompt 里显式给出。
 *  - **不参与任何决策**：不推进阶段、不决定文件白名单、不做 P4/Git 操作、不给出验证或评审结论。
 *    它的输出只有两种用途——调查 prompt 里的一段附加建议、交付描述里的一段附加文字。
 *  - 失败一律降级：超时 / 非零退出 / 输出不是严格 JSON / 字段类型不符 / 字段为空，
 *    都只是「本次没有建议」并记一条 warn 事件，绝不影响任务结论。
 *    唯一的例外是**取消**：人工取消必须原样向上抛（AgentCancelledError），不能吞掉。
 *
 *  这里刻意不引入新的调度引擎、不引入缓存、不做重试：一次调用，一次解析。
 */

/** 输入快照上限：协调者是「无工具的只读建议者」，上下文必须由编排器裁剪好，
 *  否则一次超长 prompt 只会让它超时——那与「不参与决策」一样会被降级成没有建议。 */
const MAX_TEXT = 4000;
const MAX_LIST = 12;

/** 计划建议（调查前调用）。字段全部有界，并且只是建议。 */
export interface CoordinatorPlan {
  /** 对工单的一句话理解（供调查 Agent 对齐目标，不构成结论）。 */
  understanding: string;
  /** 建议优先查看的方向（模块 / 符号 / 关键词），不是文件白名单。 */
  focus_areas: string[];
  /** 提醒注意的风险与易漏分支。 */
  risks: string[];
  /** 建议的验证方式（需要跑什么命令 / 复核什么行为），不替代 verify_cmds。 */
  verification_hints: string[];
}

/** 最终汇总（交付前调用）。 */
export interface CoordinatorSummary {
  summary: string;
  key_points: string[];
}

/** 严格字符串：类型不符就当作缺失（不把 123 / {} 这类值 String() 成看似合法的文本）。
 *  JSON 里 understanding/summary 必须是字符串——宽松转换会把跑偏的产出伪装成合法建议。 */
const strictString = (value: unknown, limit = MAX_TEXT): string => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
};

const stringList = (value: unknown, limit = MAX_LIST): string[] =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
      .map((item) => strictString(item, 400)).filter(Boolean).slice(0, limit)
    : [];

/** 严格解析：只接受 FINAL_RESULT 标记后的单个 JSON 对象（也允许整段输出就是 JSON）。
 *  这里刻意不采用「从文本里猜 JSON」的宽松链：协调者的产出只是建议，
 *  宁可直接降级成「没有建议」，也不要让一段半截或跑偏的文本混进调查 prompt / 交付描述。
 *  解析失败返回 null（调用方按降级处理）。 */
export function parseCoordinatorJson(text: string): Record<string, unknown> | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const marker = raw.lastIndexOf("FINAL_RESULT:");
  const body = (marker >= 0 ? raw.slice(marker + "FINAL_RESULT:".length) : raw).trim();
  const stripped = body.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!stripped.startsWith("{") || !stripped.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 解析计划建议：字段缺失/类型不符视为无建议（返回 null），绝不抛错。 */
export function parseCoordinatorPlan(output: string): CoordinatorPlan | null {
  const data = parseCoordinatorJson(output);
  if (!data) return null;
  const understanding = strictString(data.understanding);
  const focus_areas = stringList(data.focus_areas);
  const risks = stringList(data.risks);
  const verification_hints = stringList(data.verification_hints);
  if (!understanding && !focus_areas.length && !risks.length && !verification_hints.length) return null;
  return { understanding, focus_areas, risks, verification_hints };
}

/** 解析最终汇总：必须给出非空 summary（字符串），否则视为无建议（返回 null）。 */
export function parseCoordinatorSummary(output: string): CoordinatorSummary | null {
  const data = parseCoordinatorJson(output);
  if (!data) return null;
  const summary = strictString(data.summary);
  if (!summary) return null;
  return { summary, key_points: stringList(data.key_points) };
}

/** 计划建议 → 注入调查 prompt 的附加段落。
 *  措辞刻意写成「建议 / 非硬约束」：调查 Agent 必须仍然以真实代码与证据为准。 */
export function formatCoordinatorPlanForPrompt(plan: CoordinatorPlan): string {
  const lines = [
    "# 调查计划建议（由 coordinator 角色只读生成，仅供参考，不是硬约束）",
    "以下内容未经过代码核实，也不构成任何决策：文件白名单、阶段推进、P4/Git 操作、"
      + "验证与评审结论仍全部由编排器与你的证据链决定。与真实代码冲突时一律以代码为准。",
  ];
  if (plan.understanding) lines.push(`- 目标理解: ${plan.understanding}`);
  for (const area of plan.focus_areas) lines.push(`- 建议优先核查: ${area}`);
  for (const risk of plan.risks) lines.push(`- 需留意的风险: ${risk}`);
  for (const hint of plan.verification_hints) lines.push(`- 建议的验证方向: ${hint}`);
  lines.push("不得只依据本段做结论；若本段与代码事实冲突，请忽略本段并在结果中说明。");
  return lines.join("\n");
}

/** 交付描述里的附加段落：只追加文字，不覆盖 result.summary，也不改写任何结构化事实。 */
export function formatCoordinatorSummaryForDelivery(summary: CoordinatorSummary): string {
  const lines = ["协调者补充说明（只读、无工具，未参与任何决策，不覆盖上述测试/文件/评审事实）:"];
  lines.push(summary.summary);
  for (const point of summary.key_points) lines.push(`- ${point}`);
  return lines.join("\n");
}

/** 计划建议的 prompt。全部输入由编排器显式给出：coordinator 无工具，读不到卡片外的任何东西。 */
export function buildCoordinatorPlanPrompt(input: {
  bug: { id: string; title: string; module?: string; severity?: string; priority_label?: string };
  context: Record<string, unknown>;
  repo: { name: string; roots: Array<{ alias: string; path: string }> };
  retryEvidence?: string;
}): string {
  return [
    "你是本次 Bug 修复流程中的 coordinator（协调者）角色。你只读、无工具（不允许也无法调用任何工具），"
      + "不修改文件、不执行命令、不参与任何决策。",
    "",
    "# 你的唯一任务",
    "在只读调查开始**之前**，根据下方工单信息给出一份「调查计划建议」：应该优先看哪些方向、"
      + "有哪些容易漏的风险与分支、建议用什么方式验证。",
    "",
    "# 硬性约束",
    "1. 你拿不到仓库内容（没有工具），所以**不得声称读过任何文件**，也不得断言根因已经确认。",
    "2. 不得指定 planned_files（那是调查 Agent 的产出），不得要求扩大修改范围，不得输出补丁。",
    "3. 不得代替编排器做任何决定：阶段推进、文件白名单、P4/Git 操作、验证与评审结论都不归你。",
    "4. 只能基于下方给出的信息推断；信息不足时如实说明不确定，不要编造路径或符号。",
    "5. 必须只输出一个 JSON 对象，不要输出任何其它文字或代码围栏。",
    "",
    "# 必须遵守的输出格式（严格 JSON，不要 markdown 代码块）",
    "FINAL_RESULT: {\"understanding\":\"一句话理解\",\"focus_areas\":[\"建议核查的方向\"],"
      + "\"risks\":[\"需留意的风险\"],\"verification_hints\":[\"建议的验证方向\"]}",
    "四个字段都必须存在：understanding 是非空字符串，其余三个是字符串数组（可以为空数组）。",
    "",
    "# 工单信息",
    JSON.stringify({
      bug: input.bug,
      context: input.context,
      workspace: input.repo,
      ...(input.retryEvidence ? { retry_evidence: input.retryEvidence.slice(0, MAX_TEXT) } : {}),
    }, null, 0),
  ].join("\n");
}

/** 最终汇总的 prompt。事实由编排器整理好后原样给出：协调者只做文字组织，不重算事实。 */
export function buildCoordinatorSummaryPrompt(input: {
  bug: { id: string; title: string };
  facts: Record<string, unknown>;
}): string {
  return [
    "你是本次 Bug 修复流程中的 coordinator（协调者）角色。你只读、无工具（不允许也无法调用任何工具），"
      + "不修改文件、不参与任何决策。",
    "",
    "# 你的唯一任务",
    "在最终交付**之前**，把下方已经确定的事实整理成一段给人看的交付说明。",
    "",
    "# 硬性约束",
    "1. 下方 facts 是编排器记录的既有事实（Agent 输出、P4/Git 改动清单、机器验证结果、独立评审结论）。",
    "   你的文字只是补充说明，**不得改写、不得覆盖、不得反驳这些事实**，也不得新增未在 facts 中出现的结论。",
    "2. 不得把未通过的验证写成通过、不得把未评审写成已评审、不得把计划的改动写成已完成的改动。",
    "3. 需要提到「测试未跑」「验证缺失」「评审有 finding」时，必须与 facts 保持一致并明确说成未完成/待人工确认。",
    "4. 必须只输出一个 JSON 对象，不要输出任何其它文字或代码围栏。",
    "",
    "# 必须遵守的输出格式（严格 JSON，不要 markdown 代码块）",
    "FINAL_RESULT: {\"summary\":\"一段交付说明\",\"key_points\":[\"需要人工注意的点\"]}",
    "summary 必须是非空字符串；key_points 是字符串数组（可以为空数组）。",
    "",
    "# 工单",
    JSON.stringify({ bug: input.bug }, null, 0),
    "",
    "# facts（唯一事实来源，不得改写）",
    JSON.stringify(input.facts, null, 2),
  ].join("\n");
}
