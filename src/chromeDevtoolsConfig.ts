/**
 * Chrome DevTools MCP 代理的配置解析：连接模式、专用 profile、daemon 会话 id 与调用预算。
 *
 * chrome-devtools-mcp 1.8.0 只提供两条互斥的连接路径（`build/src/index.js:99-129`）：
 *
 * - **attach**：带 `--auto-connect` / `--browser-url` / `--ws-endpoint` 时走
 *   `ensureBrowserConnected()`，附着到用户自己启动的 Chrome。该路径要经过 Chrome 144+
 *   `chrome://inspect/#remote-debugging` 的连接授权弹窗，授权绑定这次连接的生命周期，
 *   连接一断（daemon 重启、Chrome 重启、关机）就要重新授权。
 * - **managed**：不带上述旗标时走 `ensureBrowserLaunched()`，由 MCP 自己以 `pipe: true`
 *   启动 Chrome（`build/src/browser.js:167-183`），走 stdio 管道而不是 TCP 调试端口，
 *   因此不经过 `chrome://inspect` 授权链路。显式 `--user-data-dir` 指向的目录会被
 *   **持久复用**（`build/src/browser.js:133-144`）；只有 `--isolated` 才是临时目录、关闭即清。
 *
 * managed 模式不复制、不读取用户的日常 Chrome profile，也不关闭任何 Chrome 安全机制。
 *
 * 本模块只做纯计算（不读环境、不落盘、不生成进程），以便独立单测。
 *
 * @module chromeDevtoolsConfig
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 连接模式：`attach` 复用用户已开的 Chrome，`managed` 启动项目专用 Chrome。 */
export type ChromeDevtoolsMode = "attach" | "managed";

/** 选择连接模式的环境变量；缺省为 `attach`，保持既有行为。 */
export const CHROME_MODE_ENV = "CHROME_DEVTOOLS_MODE";

/** managed 模式的持久 profile 目录覆盖；越出 workspace 时可能需要正式审批。 */
export const CHROME_PROFILE_DIR_ENV = "CHROME_DEVTOOLS_PROFILE_DIR";

/** managed 模式可选的自定义 Chrome 可执行文件路径。 */
export const CHROME_EXECUTABLE_ENV = "CHROME_DEVTOOLS_EXECUTABLE_PATH";

/** attach 模式的 daemon 会话 id 覆盖（沿用既有变量名）。 */
export const CHROME_ATTACH_SESSION_ID_ENV = "CHROME_DEVTOOLS_SESSION_ID";

/** managed 模式的 daemon 会话 id 覆盖。 */
export const CHROME_MANAGED_SESSION_ID_ENV = "CHROME_DEVTOOLS_MANAGED_SESSION_ID";

/** 单次 daemon 工具调用的等待上限覆盖（毫秒）。 */
export const CHROME_CALL_TIMEOUT_ENV = "CHROME_DEVTOOLS_CALL_TIMEOUT_MS";

/**
 * daemon 元数据（PID 文件与命名管道）只由 session id 区分
 * （`build/src/daemon/utils.js:24-44,64-68`），所以两种模式必须用不同的 id，
 * 否则切换模式后旧 daemon 仍占着管道，新参数不会生效。
 */
export const DEFAULT_ATTACH_SESSION_ID = "74617064";
export const DEFAULT_MANAGED_SESSION_ID = "74617065";

/** 官方 `assertValidSessionId` 接受的字符集（`build/src/daemon/utils.js:19`）。 */
export const SESSION_ID_PATTERN = /^[a-fA-F0-9-]+$/u;

/** 项目内默认的专用 profile 目录名（已加入 .gitignore）。 */
export const DEFAULT_PROFILE_DIR_NAME = ".chrome-profile";

/**
 * 单次 daemon 工具调用的默认等待上限。
 *
 * 必须**早于**外层 MCP 客户端超时结束，否则外层先超时，用户只能看到一条笼统的
 * 「MCP 调用超时」，而不是代理给出的可读原因。项目 `config.yaml` 里
 * `chrome_devtools.tool_timeout_sec` 默认 90s，这里留 15s 余量。
 * 默认值同时兼顾正常页面加载与截图，不要为了「快速失败」调小到几秒。
 */
export const DEFAULT_CALL_TIMEOUT_MS = 75_000;

/** 调用预算的合法区间：下限防止误配成近乎立即失败，上限防止死等。 */
export const MIN_CALL_TIMEOUT_MS = 1_000;
export const MAX_CALL_TIMEOUT_MS = 600_000;

/** 模式解析结果：`warning` 只在取值非法时出现，便于调用方按自己的渠道上报。 */
export interface ChromeModeResolution {
  /** 生效模式；取值非法时回退到 `attach`（保持既有行为，不静默改变连接语义）。 */
  readonly mode: ChromeDevtoolsMode
  /** 面向用户的非法取值提示，仅在输入不可识别时存在。 */
  readonly warning?: string
}

/**
 * 把环境变量取值解析为连接模式。缺省与非法取值都回退到 `attach`，
 * 因为 `attach` 是既有行为；`managed` 只由显式配置开启。
 * @param raw - `CHROME_DEVTOOLS_MODE` 的原始取值。
 * @returns 生效模式，以及非法取值时的提示文本。
 */
export function resolveChromeMode(raw: string | undefined): ChromeModeResolution {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "attach") return { mode: "attach" };
  if (value === "managed") return { mode: "managed" };
  return {
    mode: "attach",
    warning: `未知的 ${CHROME_MODE_ENV} 取值 "${raw}"；已回退到 attach（附着现有 Chrome，需要 Chrome 连接授权）。`
      + ` 可选值：attach、managed。`,
  };
}

/**
 * 由本模块位置推出项目根目录。代理与帮助模块都位于 `<root>/dist/`（或 dev 下的 `<root>/src/`），
 * 因此取两级父目录即可，不受启动 cwd 影响。
 * @param moduleUrl - 调用方的 `import.meta.url`。
 * @returns 项目根目录绝对路径。
 */
export function projectRootFromModuleUrl(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

/** managed 模式的运行期选项。 */
export interface ManagedOptions {
  /** 持久 profile 目录；缺省为 `<projectRoot>/.chrome-profile`。 */
  readonly profileDir?: string
  /** 自定义 Chrome 可执行文件路径；仅在配置时追加。 */
  readonly executablePath?: string
}

/**
 * 构造官方 daemon（即 chrome-devtools-mcp server）的参数向量。
 *
 * `attach` 的返回值与历史实现逐字一致，保证既有部署不因升级而改变连接语义。
 * `managed` 绝不携带 `--isolated`（临时 profile、关闭即清）、`--browser-url`、
 * `--ws-endpoint`（与 `userDataDir` 互斥），也不携带 `--no-sandbox` 等降低浏览器安全的旗标。
 * @param mode - 生效的连接模式。
 * @param options - managed 模式的目录与可执行文件配置。
 * @returns 传给 `startDaemon` 的参数数组。
 */
export function buildDaemonArgs(mode: ChromeDevtoolsMode, options: ManagedOptions = {}): string[] {
  if (mode === "attach") return ["--viaCli", "--auto-connect", "--no-performance-crux"];
  if (options.profileDir === undefined || options.profileDir === "") {
    throw new Error(`managed 模式需要持久 profile 目录（${CHROME_PROFILE_DIR_ENV}），不能为空`);
  }
  const args = [
    "--viaCli",
    "--no-performance-crux",
    // 显式声明可见窗口（官方 boolean，false 的规范拼法就是 CLI 自己序列化出的 --no-headless）：
    // 首次登录必须能看到浏览器，不能依赖「不带连接旗标时 CLI 默认 headless」这类隐式默认。
    "--no-headless",
    `--user-data-dir=${options.profileDir}`,
  ];
  // --auto-connect 与 --executable-path 在官方选项表里互斥，managed 不带 auto-connect，因此可以共存。
  if (options.executablePath !== undefined && options.executablePath !== "") {
    args.push(`--executable-path=${options.executablePath}`);
  }
  return args;
}

/**
 * managed 模式应使用的持久 profile 目录。默认落在项目内的专用目录（已 gitignore），
 * 不写用户日常 profile，也不越出 workspace；显式覆盖时才使用外部路径。
 * @param projectRoot - 项目根目录绝对路径。
 * @param configured - `CHROME_DEVTOOLS_PROFILE_DIR` 的原始取值。
 * @returns profile 目录绝对路径。
 */
export function resolveManagedProfileDir(projectRoot: string, configured: string | undefined): string {
  const value = (configured ?? "").trim();
  return value === "" ? path.join(projectRoot, DEFAULT_PROFILE_DIR_NAME) : path.resolve(value);
}

/**
 * 解析两种模式各自的 daemon 会话 id。两者取值必须不同，否则两种模式会争抢同一个
 * 命名管道与 PID 文件，切换模式后旧 daemon 仍会继续服务。
 * @param mode - 生效的连接模式。
 * @param env - 环境变量来源，缺省为 `process.env`。
 * @returns 该模式使用的会话 id。
 */
export function resolveSessionId(
  mode: ChromeDevtoolsMode,
  env: Record<string, string | undefined> = process.env,
): string {
  const sessionId = resolveSessionIds(env)[mode];
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    const name = mode === "attach" ? CHROME_ATTACH_SESSION_ID_ENV : CHROME_MANAGED_SESSION_ID_ENV;
    throw new Error(`${name} 取值 "${sessionId}" 非法：只允许十六进制字符与连字符（官方 assertValidSessionId 约束）`);
  }
  return sessionId;
}

/**
 * 同时解析两种模式的生效会话 id，并强制它们不同。默认值本就不同，但自定义环境变量
 * 可以把两者配成同一个值——那种配置会让两种模式争抢同一个命名管道与 PID 文件，
 * 因此在这里显式失败，而不是留到运行时表现为「切换模式后参数不生效」。
 * @param env - 环境变量来源，缺省为 `process.env`。
 * @returns 两种模式各自的生效会话 id。
 */
export function resolveSessionIds(
  env: Record<string, string | undefined> = process.env,
): { attach: string; managed: string } {
  const attach = effectiveSessionId("attach", env);
  const managed = effectiveSessionId("managed", env);
  if (attach === managed) {
    throw new Error(
      `${CHROME_ATTACH_SESSION_ID_ENV} 与 ${CHROME_MANAGED_SESSION_ID_ENV} 取到同一个会话 id "${attach}"：`
      + "两种模式会共用命名管道与 PID 文件，切换模式后旧 daemon 仍会继续服务。请给两者配置不同的值。",
    );
  }
  return { attach, managed };
}

/** 取某个模式的生效 id，不做格式校验（格式只在真正使用该模式时校验）。 */
function effectiveSessionId(
  mode: ChromeDevtoolsMode,
  env: Record<string, string | undefined>,
): string {
  const configured = mode === "attach"
    ? env[CHROME_ATTACH_SESSION_ID_ENV]
    : env[CHROME_MANAGED_SESSION_ID_ENV];
  const value = (configured ?? "").trim();
  if (value !== "") return value;
  return mode === "attach" ? DEFAULT_ATTACH_SESSION_ID : DEFAULT_MANAGED_SESSION_ID;
}

/** 调用预算解析结果。 */
export interface CallTimeoutResolution {
  /** 生效的单次调用等待上限（毫秒）。 */
  readonly timeoutMs: number
  /** 面向用户的非法取值提示，仅在取值不可用时存在。 */
  readonly warning?: string
}

/**
 * 解析单次 daemon 调用的等待上限。
 *
 * 目标只有一个：让代理自己的超时**先于**外层 MCP 客户端超时发生，从而返回一条
 * 可读的 `isError`（含 daemon 不健康的真实原因），而不是让两层超时叠加后只看到外层的
 * 笼统报错。缺省值 {@link DEFAULT_CALL_TIMEOUT_MS} 对正常页面加载、快照与截图仍然宽松，
 * 不做成一刀切的短超时；页面确实更慢时应同步调大本项目 `chrome_devtools.tool_timeout_sec`
 * 与本值。
 * @param raw - `CHROME_DEVTOOLS_CALL_TIMEOUT_MS` 的原始取值。
 * @returns 生效超时（毫秒），以及非法取值时的提示文本。
 */
export function resolveCallTimeoutMs(raw: string | undefined): CallTimeoutResolution {
  const value = (raw ?? "").trim();
  if (value === "") return { timeoutMs: DEFAULT_CALL_TIMEOUT_MS };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CALL_TIMEOUT_MS || parsed > MAX_CALL_TIMEOUT_MS) {
    return {
      timeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      warning: `${CHROME_CALL_TIMEOUT_ENV} 取值 "${raw}" 不可用；已回退到默认 ${DEFAULT_CALL_TIMEOUT_MS}ms。`
        + ` 合法区间：${MIN_CALL_TIMEOUT_MS}-${MAX_CALL_TIMEOUT_MS}。`,
    };
  }
  return { timeoutMs: parsed };
}
