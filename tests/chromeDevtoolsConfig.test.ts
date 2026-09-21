import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

import {
  CHROME_ATTACH_SESSION_ID_ENV,
  CHROME_CALL_TIMEOUT_ENV,
  CHROME_MANAGED_SESSION_ID_ENV,
  CHROME_MODE_ENV,
  DEFAULT_ATTACH_SESSION_ID,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_MANAGED_SESSION_ID,
  DEFAULT_PROFILE_DIR_NAME,
  MAX_CALL_TIMEOUT_MS,
  MIN_CALL_TIMEOUT_MS,
  SESSION_ID_PATTERN,
  buildDaemonArgs,
  projectRootFromModuleUrl,
  resolveCallTimeoutMs,
  resolveChromeMode,
  resolveManagedProfileDir,
  resolveSessionId,
  resolveSessionIds,
} from "../src/chromeDevtoolsConfig.js";

/** 历史实现逐字使用的参数向量：升级后 attach 语义必须完全不变。 */
const LEGACY_ATTACH_ARGS = ["--viaCli", "--auto-connect", "--no-performance-crux"];

/** managed 模式绝不能出现的旗标：临时 profile、互斥的连接方式、降低浏览器安全的开关。 */
const FORBIDDEN_MANAGED_FLAGS = [
  "--auto-connect",
  "--isolated",
  "--browser-url",
  "--ws-endpoint",
  "--no-sandbox",
  "--disable-web-security",
];

const exampleConfig = () => load(
  fs.readFileSync(fileURLToPath(new URL("../config.example.yaml", import.meta.url)), "utf8"),
) as {
  mcp_servers: Record<string, { tool_timeout_sec?: number; env?: Record<string, string> }>
};

describe("Chrome DevTools 连接模式", () => {
  it("缺省与显式 attach 都解析为 attach", () => {
    expect(resolveChromeMode(undefined)).toEqual({ mode: "attach" });
    expect(resolveChromeMode("")).toEqual({ mode: "attach" });
    expect(resolveChromeMode("attach")).toEqual({ mode: "attach" });
  });

  it("managed 大小写与空白无关", () => {
    expect(resolveChromeMode("managed")).toEqual({ mode: "managed" });
    expect(resolveChromeMode("  Managed  ")).toEqual({ mode: "managed" });
  });

  it("非法取值回退 attach 并给出提示，不静默改变连接语义", () => {
    const resolved = resolveChromeMode("manged");
    expect(resolved.mode).toBe("attach");
    expect(resolved.warning).toContain("manged");
    expect(resolved.warning).toContain(CHROME_MODE_ENV);
    // 提示必须点明回退后的真实后果，否则用户不知道浏览器会要求授权。
    expect(resolved.warning).toContain("attach");
  });
});

describe("daemon 参数向量", () => {
  it("attach 与历史实现逐字一致", () => {
    expect(buildDaemonArgs("attach")).toEqual(LEGACY_ATTACH_ARGS);
    // 即便传了 managed 选项，attach 也不得带上它们。
    expect(buildDaemonArgs("attach", { profileDir: "C:\\tmp\\p", executablePath: "C:\\chrome.exe" }))
      .toEqual(LEGACY_ATTACH_ARGS);
  });

  it("managed 用显式持久 user-data-dir，且不含任何禁用旗标", () => {
    const profileDir = "C:\\AppProject\\TapdBugFixAgent\\.chrome-profile";
    const args = buildDaemonArgs("managed", { profileDir });
    expect(args).toEqual([
      "--viaCli",
      "--no-performance-crux",
      "--no-headless",
      `--user-data-dir=${profileDir}`,
    ]);
    for (const flag of FORBIDDEN_MANAGED_FLAGS) {
      expect(args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))).toBe(false);
    }
  });

  it("managed 显式声明可见窗口，不依赖 CLI 的隐式 headless 默认", () => {
    const args = buildDaemonArgs("managed", { profileDir: "C:\\tmp\\p" });
    expect(args).toContain("--no-headless");
    // 不能出现肯定形式的 --headless（那会让首次登录看不到窗口）。
    expect(args.some((arg) => arg === "--headless" || arg.startsWith("--headless="))).toBe(false);
  });

  it("managed 可选追加 executable-path，且仍不与 auto-connect 共存（官方互斥）", () => {
    const args = buildDaemonArgs("managed", {
      profileDir: "C:\\tmp\\p",
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    expect(args).toContain("--executable-path=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    expect(args).not.toContain("--auto-connect");
  });

  it("managed 空 executable-path 不产生空旗标", () => {
    expect(buildDaemonArgs("managed", { profileDir: "C:\\tmp\\p", executablePath: "" }))
      .toEqual(["--viaCli", "--no-performance-crux", "--no-headless", "--user-data-dir=C:\\tmp\\p"]);
  });

  it("managed 缺 profile 目录时显式失败，而不是退化成临时 profile", () => {
    expect(() => buildDaemonArgs("managed")).toThrow(/profile/);
    expect(() => buildDaemonArgs("managed", { profileDir: "" })).toThrow(/profile/);
  });
});

describe("daemon 会话隔离", () => {
  it("两种模式的默认会话 id 不同且符合官方字符集", () => {
    const attach = resolveSessionId("attach", {});
    const managed = resolveSessionId("managed", {});
    expect(attach).toBe(DEFAULT_ATTACH_SESSION_ID);
    expect(managed).toBe(DEFAULT_MANAGED_SESSION_ID);
    expect(attach).not.toBe(managed);
    expect(attach).toMatch(SESSION_ID_PATTERN);
    expect(managed).toMatch(SESSION_ID_PATTERN);
  });

  it("各模式读各自的环境变量覆盖，互不串联", () => {
    const env = {
      [CHROME_ATTACH_SESSION_ID_ENV]: "aaaa1111",
      [CHROME_MANAGED_SESSION_ID_ENV]: "bbbb2222",
    };
    expect(resolveSessionId("attach", env)).toBe("aaaa1111");
    expect(resolveSessionId("managed", env)).toBe("bbbb2222");
    // 只设 attach 变量时，managed 仍走自己的默认值。
    expect(resolveSessionId("managed", { [CHROME_ATTACH_SESSION_ID_ENV]: "aaaa1111" }))
      .toBe(DEFAULT_MANAGED_SESSION_ID);
  });

  it("非法会话 id 显式失败并点名变量（官方 assertValidSessionId 会直接抛）", () => {
    expect(() => resolveSessionId("managed", { [CHROME_MANAGED_SESSION_ID_ENV]: "bad id!" }))
      .toThrow(CHROME_MANAGED_SESSION_ID_ENV);
  });

  it("两模式被配成同一个会话 id 时显式报错，而不是留到运行时争抢管道", () => {
    const same = { [CHROME_ATTACH_SESSION_ID_ENV]: "abc123", [CHROME_MANAGED_SESSION_ID_ENV]: "abc123" };
    expect(() => resolveSessionIds(same)).toThrow(/abc123/);
    expect(() => resolveSessionIds(same)).toThrow(CHROME_ATTACH_SESSION_ID_ENV);
    expect(() => resolveSessionIds(same)).toThrow(CHROME_MANAGED_SESSION_ID_ENV);
    // 经 resolveSessionId 进入也要被拦下（任取一种模式都算配置错误）。
    expect(() => resolveSessionId("managed", same)).toThrow(CHROME_MANAGED_SESSION_ID_ENV);
  });

  it("默认配置下两者不同，检查不会误报", () => {
    expect(() => resolveSessionIds({})).not.toThrow();
    expect(resolveSessionIds({})).toEqual({
      attach: DEFAULT_ATTACH_SESSION_ID,
      managed: DEFAULT_MANAGED_SESSION_ID,
    });
  });
});

describe("专用 profile 目录", () => {
  it("默认落在项目内的专用目录，不越出 workspace", () => {
    const root = projectRootFromModuleUrl(import.meta.url);
    const dir = resolveManagedProfileDir(root, undefined);
    expect(dir.startsWith(root)).toBe(true);
    expect(dir.endsWith(DEFAULT_PROFILE_DIR_NAME)).toBe(true);
  });

  it("显式覆盖时解析为绝对路径", () => {
    expect(resolveManagedProfileDir("C:\\root", "D:\\profiles\\chrome")).toBe("D:\\profiles\\chrome");
  });

  it("默认 profile 目录已加入 .gitignore", () => {
    const ignore = fs.readFileSync(fileURLToPath(new URL("../.gitignore", import.meta.url)), "utf8");
    expect(ignore.split(/\r?\n/u)).toContain(`${DEFAULT_PROFILE_DIR_NAME}/`);
  });
});

describe("调用预算", () => {
  it("缺省预算对正常页面加载仍然宽松", () => {
    expect(resolveCallTimeoutMs(undefined)).toEqual({ timeoutMs: DEFAULT_CALL_TIMEOUT_MS });
    expect(DEFAULT_CALL_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("合法取值生效，越界与非法取值回退默认并提示", () => {
    expect(resolveCallTimeoutMs("45000").timeoutMs).toBe(45_000);
    expect(resolveCallTimeoutMs("45000").warning).toBeUndefined();

    for (const bad of [String(MIN_CALL_TIMEOUT_MS - 1), String(MAX_CALL_TIMEOUT_MS + 1), "abc", "1500.5"]) {
      const resolved = resolveCallTimeoutMs(bad);
      expect(resolved.timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
      expect(resolved.warning).toContain(CHROME_CALL_TIMEOUT_ENV);
    }
  });

  it("代理超时必须早于外层 MCP 的 tool_timeout_sec，否则外层先超时只留下笼统报错", () => {
    const chrome = exampleConfig().mcp_servers["chrome_devtools"];
    expect(chrome?.tool_timeout_sec).toBeGreaterThan(0);
    expect(DEFAULT_CALL_TIMEOUT_MS).toBeLessThan(chrome!.tool_timeout_sec! * 1000);
  });

  it("示例配置里写明的预算与代码默认值一致，避免两处漂移", () => {
    const configured = exampleConfig().mcp_servers["chrome_devtools"]?.env?.[CHROME_CALL_TIMEOUT_ENV];
    expect(configured).toBeDefined();
    expect(resolveCallTimeoutMs(configured).timeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
  });
});
