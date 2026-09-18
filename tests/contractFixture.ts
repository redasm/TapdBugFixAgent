/** Shared acceptance data for orchestration tests; semantic contract checks have dedicated cases. */
export const contractFixture = {
  acceptance_cases: [{ given: "已进入目标功能", when: "触发工单操作", then: "返回预期结果且不再出现目标异常", source_refs: ["evidence:0"] }],
  preserved_behaviors: ["正常输入继续完成原业务操作"],
  domain_facts: [{ concept: "操作状态", meaning: "表示本次操作结果，不能以无异常代替业务成功", source_refs: ["evidence:0"] }],
  reuse_options: [{ symbol: "目标操作入口", action: "reuse", reason: "沿用原入口及相关错误处理路径" }],
  open_questions: [],
};
