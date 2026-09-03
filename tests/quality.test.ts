import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig, validateConfig } from "../src/config.js";
import type { Bug } from "../src/models.js";
import {
  assessFixability,
  buildBugContext,
  formatBugContext,
  type AdmissionPolicy,
} from "../src/quality.js";
import {
  buildImplementationPrompt,
  buildInvestigationPrompt,
  parseInvestigation,
} from "../src/repairWorkflow.js";
import { assessPatchScope, assessPlannedScope, runVerificationPipeline } from "../src/verify.js";
import { buildReviewPrompt, formatReviewerFeedback, parseReviewResult } from "../src/review.js";

const makeBug = (over: Partial<Bug> = {}): Bug => ({
  id: "1152729922000000001",
  workspace_id: "1152729922",
  title: "保存设置后刷新会恢复旧值",
  description: "复现步骤：进入设置页，启用提醒并保存，刷新后开关恢复关闭。预期：保存后保持开启。实际：恢复关闭。",
  status: "new",
  priority: "1",
  priority_label: "高",
  severity: "严重",
  module: "Settings",
  current_owner: "tester",
  reporter: "reporter",
  created: "2026-08-20 10:00:00",
  raw: {
    version_report: "0.7.0.1234",
    platform: "Windows",
    os: "Windows 11",
    steps: "1. 打开设置\n2. 开启提醒\n3. 保存并刷新",
    expectation: "刷新后仍为开启",
    actual: "刷新后恢复关闭",
    comments: [{ author: "QA", description: "日志显示 save 返回成功，但服务端值未变化" }],
  },
  ...over,
});

const policy: AdmissionPolicy = {
  min_score: 55,
  require_reproduction_signal: true,
  manual_keywords: ["prefab", "场景", "xlsx"],
  high_risk_keywords: ["支付", "账号", "存档", "协议"],
};

describe("BugContextBuilder", () => {
  it("把 TAPD 原始字段整理为结构化修复上下文", () => {
    const context = buildBugContext(makeBug());

    expect(context.reproduction_steps).toContain("打开设置");
    expect(context.expected_result).toBe("刷新后仍为开启");
    expect(context.actual_result).toBe("刷新后恢复关闭");
    expect(context.environment).toEqual(expect.arrayContaining(["版本: 0.7.0.1234", "平台: Windows"]));
    expect(context.comments).toEqual(["QA: 日志显示 save 返回成功，但服务端值未变化"]);
  });

  it("保留 TAPD 附件对象的名称和下载地址作为调查线索", () => {
    const context = buildBugContext(makeBug({
      raw: {
        attachments: [
          { file_name: "error.log", download_url: "https://tapd.example/error.log" },
          { name: "screen.png" },
        ],
      },
    }));

    expect(context.attachments).toEqual([
      "error.log: https://tapd.example/error.log",
      "screen.png",
    ]);
  });

  it("从 CrashSight 工单正文提取诊断链接、堆栈模块并进入自动调查", () => {
    const description = [
      "异常详情地址: https://crashsight.qq.com/crash-reporting/crashes/app/issue/report?pid=10",
      "出错堆栈: UUIDynmaicTextureAtlasMgr::RemoveFromAtlas",
      "D:\\WS\\Engine\\Plugins\\Kuro\\LGUI\\LGUI\\Source\\Private\\UIDynmaicTextureAtlasMgr.cpp:173",
    ].join(" ");
    const bug = makeBug({
      title: "【CrashSight一键提单】Fatal Error UUIDynmaicTextureAtlasMgr::RemoveFromAtlas",
      description,
      module: "",
      raw: {},
    });

    const context = buildBugContext(bug);
    const result = assessFixability(bug, policy);

    expect(context.module).toBe("LGUI");
    expect(context.diagnostic_links).toEqual([
      "https://crashsight.qq.com/crash-reporting/crashes/app/issue/report?pid=10",
    ]);
    expect(formatBugContext(context)).toContain("外部诊断链接");
    expect(result.disposition).toBe("auto_fix");
    expect(result.reasons).toEqual([]);
  });

  it("只有受登录保护的 Sentry 链接和 Crash 标题时也允许进入只读调查", () => {
    const result = assessFixability(makeBug({
      title: "【客户端】【Crash】FDebug::CheckVerifyFailedImpl2 Fatal Error",
      description: "http://sentry.nami.kuro.com/organizations/sentry/issues/2072/",
      module: "战斗-战斗功能",
      raw: {},
    }), policy);

    expect(result.disposition).toBe("auto_fix");
    expect(result.eligible).toBe(true);
  });

  it("格式化时明确展示缺失信息，不让 Agent 把空字段当证据", () => {
    const context = buildBugContext(makeBug({ description: "按钮坏了", raw: {} }));
    const text = formatBugContext(context);

    expect(text).toContain("复现步骤: （缺失）");
    expect(text).toContain("预期结果: （缺失）");
    expect(text).toContain("实际结果: （缺失）");
  });
});

describe("FixabilityAdmission", () => {
  it("证据充分的局部代码 Bug 允许进入自动修复", () => {
    const result = assessFixability(makeBug(), policy);

    expect(result.eligible).toBe(true);
    expect(result.disposition).toBe("auto_fix");
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it("完整写在标题里的操作和故障现象可进入只读调查", () => {
    const result = assessFixability(
      makeBug({
        title: "【关卡】【地图】点击吸附在边缘的标记会异常触发预放置状态",
        description: "",
        module: "地图",
        raw: {},
      }),
      policy,
    );

    expect(result.eligible).toBe(true);
    expect(result.disposition).toBe("auto_fix");
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it("只有模糊一句话且没有复现信号时要求补充信息", () => {
    const result = assessFixability(
      makeBug({ title: "功能异常", description: "不对", module: "", raw: {} }),
      policy,
    );

    expect(result.eligible).toBe(false);
    expect(result.disposition).toBe("needs_info");
    expect(result.reasons.join(" ")).toContain("复现");
  });

  it("资源类和高风险任务进入人工处理", () => {
    const resource = assessFixability(
      makeBug({ title: "场景 prefab 显示错误", description: "需要调整 prefab" }),
      policy,
    );
    const risky = assessFixability(
      makeBug({ title: "支付协议字段错误", description: "复现步骤完整，支付协议字段不一致" }),
      policy,
    );

    expect(resource.disposition).toBe("manual_only");
    expect(risky.disposition).toBe("manual_review");
  });

  it("已启用对应 MCP 时 prefab 资源 Bug 可进入自动调查", () => {
    const resource = assessFixability(
      makeBug({ title: "场景 prefab 显示错误", description: "复现步骤：打开界面。预期结果：节点可见。实际结果：节点消失。" }),
      policy,
      ["prefab", "预制体", "lgui", "场景"],
    );

    expect(resource.disposition).toBe("auto_fix");
    expect(resource.eligible).toBe(true);
  });

  it("测试账号只作为复现前置时不误判为账号高风险", () => {
    const result = assessFixability(
      makeBug({
        title: "切换输出角色后通关时间残留",
        description: "测试账号：qa_01\n复现步骤：进入爬塔并从A角色切换到B角色。\n预期结果：各角色单独记录。\n实际结果：B角色显示A角色时间。",
        module: "爬塔",
        raw: {},
      }),
      policy,
    );

    expect(result.disposition).toBe("auto_fix");
    expect(result.reasons).not.toContain(expect.stringContaining("账号"));
  });
});

describe("quality config", () => {
  it("默认启用准入门禁、两次修复机会和严格验证状态", () => {
    const cfg = loadConfig("NO_SUCH_CONFIG.yaml", "NO_SUCH_ENV.env", "NO_SUCH_OVERRIDES.yaml");

    expect(cfg.max_attempts).toBe(2);
    expect(cfg.quality.admission.min_score).toBe(55);
    expect(cfg.quality.admission.require_reproduction_signal).toBe(true);
    expect(cfg.quality.require_verification).toBe(true);
    expect(cfg.review.enabled).toBe(true);
    expect(cfg.review.max_fix_rounds).toBe(1);
  });

  it("拒绝旧配置字段，要求开发环境直接改用新版 schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-quality-config-"));
    const cfgPath = path.join(dir, "config.yaml");
    fs.writeFileSync(cfgPath, `mode: review
llm_review: true
poll_interval_min: 30
quality:
  investigation_enabled: true
workspaces:
  - workspace_id: "1"
    owner: me
    comment_status: resolved
    repos:
      - name: app
        path: .
        test_cmd: "npm test"
`);

    expect(() => loadConfig(cfgPath, "NO_SUCH_ENV.env", "NO_SUCH_OVERRIDES.yaml"))
      .toThrow(/不再支持的配置字段.*mode.*llm_review.*poll_interval_min.*investigation_enabled.*comment_status.*test_cmd/s);
  });

  it("严格验证开启但仓库无验证命令时给出配置警告", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-quality-warning-"));
    const cfgPath = path.join(dir, "config.yaml");
    fs.writeFileSync(cfgPath, `workspaces:\n  - workspace_id: "1"\n    owner: me\n    repos:\n      - name: app\n        path: ${JSON.stringify(dir)}\n`);
    const cfg = loadConfig(cfgPath, "NO_SUCH_ENV.env", "NO_SUCH_OVERRIDES.yaml");

    expect(validateConfig(cfg).join("\n")).toContain("未配置 verify_cmds");
  });
});

describe("two-stage repair workflow", () => {
  it("调查 Prompt 强制只读、要求根因证据和可验证复现", () => {
    const prompt = buildInvestigationPrompt(makeBug(), "app", "C:\\repo");

    expect(prompt).toContain("只读调查阶段");
    expect(prompt).toContain("禁止修改");
    expect(prompt).toContain("复现步骤: 1. 打开设置");
    expect(prompt).toContain('"root_cause"');
    expect(prompt).toContain('"reproduction"');
    expect(prompt).toContain('"planned_files"');
  });

  it("调查 Prompt 要求区分事实与推断、比较假设并定义停止条件", () => {
    const prompt = buildInvestigationPrompt(makeBug(), "app", "C:\\repo");

    expect(prompt).toContain("观察事实");
    expect(prompt).toContain("推断");
    expect(prompt).toContain("尚未验证");
    expect(prompt).toContain("候选假设");
    expect(prompt).toContain("排除依据");
    expect(prompt).toContain("先阅读相关测试");
    expect(prompt).toContain("停止调查并写入 blocked_reasons");
    expect(prompt).toContain("工具调用次数不设固定上限");
    expect(prompt).toContain("不得在 Perforce 根执行 git status/log/blame/diff");
    expect(prompt).toContain("p4 filelog");
    expect(prompt).toContain('git -C "根的绝对路径"');
    expect(prompt).toContain("rg` 无匹配时 exit code 1");
    expect(prompt).toContain("rg ... | Select-Object -First");
  });

  it("调查 Prompt 强制读取 CrashSight 和 Sentry 外部诊断链接", () => {
    const prompt = buildInvestigationPrompt(makeBug({
      description: "详情: https://crashsight.qq.com/crash-reporting/crashes/app/issue/report",
    }), "app", "C:\\repo");

    expect(prompt).toContain("必须先调用服务 `chrome_devtools`");
    expect(prompt).toContain("用 `new_page` 为每个链接创建独立页面");
    expect(prompt).toContain("完整堆栈");
    expect(prompt).toContain("跳转登录页");
    expect(prompt).toContain("必须在 blocked_reasons 中写明");
    expect(prompt).toContain('"diagnostic_pages"');
  });

  it("存在外部诊断链接时拒绝未实际读取页面的调查结果", () => {
    const url = "https://crashsight.qq.com/crash-reporting/crashes/app/issue/report";
    const base = {
      root_cause: "空指针",
      evidence: ["[观察] Source/Foo.cpp:42 解引用为空", "[推断] 空指针导致崩溃"],
      reproduction: { command: "", before: "EXCEPTION_ACCESS_VIOLATION_READ" },
      planned_files: ["Source/Foo.cpp"],
      confidence: 0.9,
      blocked_reasons: [],
    };

    expect(parseInvestigation(`FINAL_RESULT: ${JSON.stringify(base)}`, [url]).ok).toBe(false);
    const read = parseInvestigation(`FINAL_RESULT: ${JSON.stringify({
      ...base,
      diagnostic_pages: [{
        url,
        status: "read",
        title: "Tencent CrashSight",
        facts: ["异常名 EXCEPTION_ACCESS_VIOLATION_READ", "累计发生 2 次"],
        error: "",
      }],
    })}`, [url]);
    expect(read.ok).toBe(true);
    expect(read.diagnostic_pages[0].facts).toHaveLength(2);
  });

  it("资源调查启用 MCP 后不再因二进制资源直接停止", () => {
    const prompt = buildInvestigationPrompt(makeBug(), "app", "C:\\repo", true);

    expect(prompt).toContain("通用 Unreal MCP 和 Prefab/LGUI MCP 的只读工具");
    expect(prompt).toContain("不要因为资源是二进制而直接停止");
    expect(prompt).toContain("与仓库路径 C:\\repo 不一致");
    expect(prompt).toContain("服务 `unreal_mcp` 的 `ping` 工具");
    expect(prompt).toContain("服务 `prefab_mcp2` 的 `lgui_ping` 工具");
    expect(prompt).toContain("禁止调用 read_mcp_resource");
    expect(prompt).toContain("禁止使用 UnrealMCP、PrefabEditorBridge");
  });

  it("解析调查结果时拒绝没有根因或证据的乐观结论", () => {
    const invalid = parseInvestigation('FINAL_RESULT: {"root_cause":"猜测","evidence":[],"confidence":0.9}');
    const valid = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42 立即显示成功","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts","tests/settings.test.ts"],"confidence":0.86,"blocked_reasons":[]}',
    );

    expect(invalid.ok).toBe(false);
    expect(valid.ok).toBe(true);
    expect(valid.planned_files).toEqual(["src/Settings.ts", "tests/settings.test.ts"]);
  });

  it("调查协议拒绝未分类证据和不安全的计划路径", () => {
    const unclassified = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["Settings.ts:42"],"reproduction":{"before":"FAIL"},"planned_files":["src/Settings.ts"],"confidence":0.9,"blocked_reasons":[]}',
    );
    const unsafePath = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 请求未等待"],"reproduction":{"before":"FAIL"},"planned_files":["../outside.ts"],"confidence":0.9,"blocked_reasons":[]}',
    );

    expect(unclassified.ok).toBe(false);
    expect(unclassified.validation_errors.join(" ")).toContain("[观察]");
    expect(unsafePath.ok).toBe(false);
    expect(unsafePath.validation_errors.join(" ")).toContain("相对路径");
  });

  it("实施 Prompt 携带调查结论、限制范围并强制回归验证", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts","tests/settings.test.ts"],"confidence":0.86,"blocked_reasons":[]}',
    );
    const prompt = buildImplementationPrompt({
      bug: makeBug(),
      repoName: "app",
      repoPath: "C:\\repo",
      verifyCommands: ["npm run typecheck", "npm test -- settings"],
      investigation,
      retryEvidence: "上次测试失败",
      reviewerFeedback: "",
    });

    expect(prompt).toContain("已确认的调查结论");
    expect(prompt).toContain("保存请求未 await");
    expect(prompt).toContain("先运行或补充能复现该 Bug 的回归测试");
    expect(prompt).toContain("只修改计划范围");
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("上次测试失败");
    expect(prompt).toContain("修复守则");
    expect(prompt).toContain("清理必须达到完全停稳");
  });

  it("实施 Prompt 定义完成标准、编辑前校验和诚实的分层验证", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts","tests/settings.test.ts"],"confidence":0.86,"blocked_reasons":[]}',
    );
    const prompt = buildImplementationPrompt({
      bug: makeBug(),
      repoName: "app",
      repoPath: "C:\\repo",
      verifyCommands: ["npm run typecheck"],
      investigation,
      retryEvidence: "",
      reviewerFeedback: "",
    });

    expect(prompt).toContain("完成标准");
    expect(prompt).toContain("编辑前检查");
    expect(prompt).toContain("调查结论与当前代码矛盾");
    expect(prompt).toContain("先运行 Bug 专项复现");
    expect(prompt).toContain("再运行最小相关测试");
    expect(prompt).toContain("最后运行配置的机器验证命令");
    expect(prompt).toContain("检查最终 diff");
    expect(prompt).toContain("未运行、失败、通过");
  });

  it("资源实施启用 MCP 后要求通过 MCP 修改并回读验证", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"Prefab 属性错误","evidence":["[观察] MCP 节点属性不匹配","[推断] 属性错误导致显示异常"],"reproduction":{"before":"截图中节点消失"},"planned_files":["Content/UI/Test.prefab"],"confidence":0.86,"blocked_reasons":[]}',
    );
    const prompt = buildImplementationPrompt({
      bug: makeBug(), repoName: "app", repoPath: "C:\\repo", verifyCommands: [],
      investigation, retryEvidence: "", reviewerFeedback: "", unrealMcpEnabled: true,
    });

    expect(prompt).toContain("资源修改必须通过 MCP 原子工具完成");
    expect(prompt).toContain("成功修改的资源列入 changed_files");
    expect(prompt).toContain("与目标仓库 C:\\repo 一致");
    expect(prompt).toContain("必须直接调用配置名 `unreal_mcp`、`prefab_mcp2`");
    expect(prompt).toContain("禁止调用 read_mcp_resource");
  });

  it("修复守则覆盖根因、重试、状态机、缓存、协议与边界风险", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts"],"confidence":0.86,"blocked_reasons":[]}',
    );
    const prompt = buildImplementationPrompt({
      bug: makeBug(), repoName: "app", repoPath: "C:\\repo", verifyCommands: [],
      investigation, retryEvidence: "", reviewerFeedback: "",
    });

    expect(prompt).toContain("根因而非症状");
    expect(prompt).toContain("重试与幂等");
    expect(prompt).toContain("状态机不变量");
    expect(prompt).toContain("缓存一致性");
    expect(prompt).toContain("序列化与协议契约");
    expect(prompt).toContain("边界输入");
    expect(prompt).toContain("验证诚实性");
    expect(prompt).toContain("变更范围卫生");
  });
});

describe("strict verification pipeline", () => {
  it("没有验证命令时明确返回未配置，不能伪装成通过", async () => {
    const result = await runVerificationPipeline(process.cwd(), [], true);

    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("未配置");
  });

  it("按顺序执行验证命令并在首个失败处停止", async () => {
    const result = await runVerificationPipeline(process.cwd(), [
      'node -e "console.log(\'compile ok\')"',
      'node -e "console.error(\'regression failed\');process.exit(2)"',
      'node -e "console.log(\'must not run\')"',
    ], true);

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].ok).toBe(true);
    expect(result.steps[1].output).toContain("regression failed");
  });

  it("补丁超过文件数或 diff 行数限制时拒绝进入自动验证状态", () => {
    const tooManyFiles = assessPatchScope(["a", "b", "c"], "+x\n-y", 2, 100);
    const tooManyLines = assessPatchScope(["a"], "+1\n+2\n+3", 5, 2);

    expect(tooManyFiles.ok).toBe(false);
    expect(tooManyFiles.reasons.join(" ")).toContain("文件数");
    expect(tooManyLines.ok).toBe(false);
    expect(tooManyLines.reasons.join(" ")).toContain("diff");
  });

  it("实际修改超出调查阶段 planned_files 时拒绝候选", () => {
    const ok = assessPlannedScope(
      ["//depot/client/src/Settings.ts", "//depot/client/tests/settings.test.ts"],
      ["src/Settings.ts", "tests/settings.test.ts"],
    );
    const escaped = assessPlannedScope(
      ["//depot/client/src/Settings.ts", "//depot/client/src/Unrelated.ts"],
      ["src/Settings.ts"],
    );

    expect(ok.ok).toBe(true);
    expect(escaped.ok).toBe(false);
    expect(escaped.unplanned_files).toEqual(["//depot/client/src/Unrelated.ts"]);
  });
});

describe("independent read-only review", () => {
  it("评审 Prompt 包含完整目标、根因、验证证据和 diff，并明确禁止修改", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts"],"confidence":0.9,"blocked_reasons":[]}',
    );
    const prompt = buildReviewPrompt({
      bug: makeBug(),
      investigation,
      diff: "--- a/src/Settings.ts\n+++ b/src/Settings.ts\n-await save()\n+await save()",
      verificationSummary: "[PASS] npm test -- settings",
    });

    expect(prompt).toContain("只读代码评审");
    expect(prompt).toContain("不得修改工作区");
    expect(prompt).toContain("保存请求未 await");
    expect(prompt).toContain("[PASS] npm test -- settings");
    expect(prompt).toContain("+++ b/src/Settings.ts");
  });

  it("评审 Prompt 只阻断可执行的补丁问题并检查关键正确性维度", () => {
    const investigation = parseInvestigation(
      'FINAL_RESULT: {"root_cause":"保存请求未 await","evidence":["[观察] Settings.ts:42","[推断] 根因由该观察事实支持"],"reproduction":{"command":"npm test -- settings","before":"FAIL"},"planned_files":["src/Settings.ts"],"confidence":0.9,"blocked_reasons":[]}',
    );
    const prompt = buildReviewPrompt({
      bug: makeBug(), investigation,
      diff: "--- a/src/Settings.ts\n+++ b/src/Settings.ts\n-await save()\n+await save()",
      verificationSummary: "[PASS] npm test -- settings",
    });

    expect(prompt).toContain("补丁引入或本次补丁应解决但仍未解决");
    expect(prompt).toContain("既有且与本补丁无关的问题不得阻断");
    expect(prompt).toContain("失败场景");
    expect(prompt).toContain("根因覆盖");
    expect(prompt).toContain("回归测试质量");
    expect(prompt).toContain("状态转换");
    expect(prompt).toContain("资源所有权");
    expect(prompt).toContain("配置、数据或协议兼容性");
    expect(prompt).toContain("不要输出表扬或泛化总结");
  });

  it("解析分级、可执行 findings，存在 high/medium 时拒绝", () => {
    const result = parseReviewResult(
      'FINAL_RESULT: {"approved":true,"note":"看起来可以","findings":[{"severity":"high","title":"遗漏错误路径","file":"src/Settings.ts","line":42,"evidence":"catch 仍显示成功","required_action":"失败时返回错误"}]}',
    );

    expect(result.approved).toBe(false);
    expect(result.findings[0].severity).toBe("high");
    expect(formatReviewerFeedback(result)).toContain("失败时返回错误");
  });

  it("Reviewer 的不完整 finding 不会被静默丢弃后误批准", () => {
    const result = parseReviewResult(
      'FINAL_RESULT: {"approved":true,"note":"通过","findings":[{"severity":"medium","title":"缺少证据","required_action":"补测试"}]}',
    );

    expect(result.approved).toBe(false);
    expect(result.findings[0].title).toContain("缺失字段");
  });

  it("Reviewer 拒绝时必须给出可执行 finding", () => {
    const result = parseReviewResult(
      'FINAL_RESULT: {"approved":false,"note":"不通过","findings":[]}',
    );

    expect(result.approved).toBe(false);
    expect(result.findings[0].title).toContain("未给出可执行 finding");
  });

  it("无法解析 Reviewer 输出时保守拒绝，不把评审故障当批准", () => {
    const result = parseReviewResult("reviewer crashed");

    expect(result.approved).toBe(false);
    expect(result.findings[0].title).toContain("无法解析");
  });

  it("仅缺少游戏内人工复现时降为 low，不阻断已通过机器验证的候选", () => {
    const result = parseReviewResult(
      'FINAL_RESULT: {"approved":false,"note":"代码逻辑正确，仅缺运行期确认","findings":[{"severity":"medium","title":"验证证据不足，依赖未验证配置","file":"GuideStepInfo.ts","line":264,"evidence":"tsc 已通过，但未运行游戏内 GM 复现，配置条件尚未验证","required_action":"运行期用 TestGuideGroup 并打日志确认"}]}',
    );

    expect(result.findings[0].severity).toBe("low");
    expect(result.approved).toBe(true);
  });

  it("已证明配置使代码不可达时仍保持阻断", () => {
    const result = parseReviewResult(
      'FINAL_RESULT: {"approved":false,"note":"实际配置不满足条件","findings":[{"severity":"medium","title":"修复路径不可达","file":"GuideStepInfo.ts","line":264,"evidence":"已确认实际配置为 Priority=0、TimeScale=1，因此新逻辑不可达","required_action":"修正启动条件"}]}',
    );

    expect(result.findings[0].severity).toBe("medium");
    expect(result.approved).toBe(false);
  });
});
