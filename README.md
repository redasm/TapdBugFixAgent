# TapdBugFixAgent

自动从 Tapd 拉取分配给你的 Bug，按优先级执行 **准入 → 只读调查 → 最小修复 → 机器验证 → 独立评审**，
产出 **Perforce pending changelist**；若配置了附加 Git 引擎目录，还会创建并本地提交独立修复分支，然后回写 Tapd 评论。
配套 **Web 管理台** 实时监控与控制全流程。

![运行效果（工单编号和标题已脱敏）](web_run.jpg)

**安全约定**：永不 `p4 submit`、永不 `git push`、永不修改 Tapd 单子状态——P4 代码停在 pending changelist，Git 代码停在本地修复分支，由你 review 后人工 submit/push。
配置 Unreal MCP 后，Agent 可通过受控工具读取、修改并验证 Unreal/LGUI 资源；未命中或 MCP 未启用的二进制资源仍列入「需人工处理资源」。

主体为 TypeScript（Node ≥ 22.19）并使用 SQLite 状态库；仅启用 Unreal MCP 时需要 Python。

---

## 目录

- [快速开始](#快速开始)
- [前置条件](#前置条件)
- [配置](#配置)
- [运行](#运行)
- [Web 管理台](#web-管理台)
- [工作原理](#工作原理)
- [常见问题](#常见问题)

## 快速开始

```bash
git clone <本仓库> && cd TapdBugFixAgent

# 1. 装依赖（Node ≥ 22.19）
npm install

# 2. 装 Pi 编码 Agent
npm install -g @earendil-works/pi-coding-agent@0.85.1

# 3. 生成配置
cp config.example.yaml config.yaml
cp .env.example .env

# 4. 编辑 config.yaml（4 处必填，见下节）和 .env（Tapd 令牌）

# 5. 只读验证：能拉到"分配给我的" bug 列表即可启动
npm run dev -- list

# 6. 启动 Web 管理台
npm start -- serve
# 打开 http://127.0.0.1:8080/?token=<你的WEB_TOKEN>，点「▶ 开启」
```

## 前置条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 22.19 | 运行本体、Pi 0.85.1 与 Tapd MCP（官方包已锁定为项目依赖，stdio 模式经 `npx --no-install` 启动） |
| 编码 Agent | 全局安装 `@earendil-works/pi-coding-agent@0.85.1` |
| p4 命令行 | 在 PATH 中；为 Agent 建一个**专用 client workspace**（如 `tapd-agent_<你>`），别与日常开发共用 |
| Tapd 凭据 | **个人访问令牌**（推荐，个人设置 → 个人访问令牌 创建）或 API 账号 |
| Unreal MCP（可选） | 目标仓库包含 `Plugins/UnrealMCP`；Unreal Editor 已加载插件并启动桥接；本机 Python 可启动两个 MCP server |

Pi 直接连接模型网关，在 `config.yaml` 填写地址、API Key 和模型名称即可：

```yaml
pi:
  provider:
    base_url: "https://gateway.example.com"
    api_key: "你的 API Key"
    model_id: "网关支持的模型名称"
```

provider 名称默认 `gateway`，认证默认使用 `Authorization: Bearer`，请求使用 Anthropic Messages 协议，网关需支持该协议。模型注册由项目自动完成：只要填了 `base_url`（`api_key` 走 `api_key` 或 `PI_API_KEY`），provider 就会被注册进 `~/.pi/agent/models.json`。

`models` 列表是**动态收集**的：`model_id`（可选回退）+ 所有属于该 provider 的 `agents.roles.<role>.model`。因此有两种等价写法——只写 `model_id`（所有角色沿用同一个模型），或者不写 `model_id`、把每个角色的模型写进 `agents.roles`（例如 Reviewer 用独立模型）。带 `<别的 provider>/` 前缀的角色模型**不会**被注册进本 provider；裸模型名会自动补 `gateway/` 前缀。两者都缺时会有一条启动告警说明「provider 已注册但没有可用模型」，不会阻断启动。

## 配置

### config.yaml 必填 4 处

```yaml
workspaces:
  - workspace_id: "12345678"        # ① Tapd 项目 id（bug 链接 bug_<workspace_id>... 里就有）
    owner: "你的Tapd登录名"           # ② current_owner 过滤"分配给我的"
    repos:
      - name: "P4_Project_Name"
        path: 'D:\p4\client'        # ③ 本地 p4 workspace root（专用 client）
        verify_cmds:                # 按顺序执行；任一失败即停止
          - "npm run typecheck"
          - "npm test -- --runInBand"
        additional_dirs:            # 可选：与项目代码一起调查/修改的 Git 引擎仓库
          - name: engine
            path: 'D:\git\engine'
            vcs: git
            base_branch: branch_0.7.0
            author: developer
            ignore_paths:             # 本地构建产物：允许存在，但不检查、不提交、不回滚
              - 'Engine/Binaries/Win64/UnrealBuildAccelerator/'
            verify_cmds:
              - "cmake --build build --config Development"

p4:
  port: p4.example.com:1666         # ④ p4 服务器
  client: tapd-agent_you            #    专用 client 名
  user: you
  password: "..."
```

Pi 模型、Web token、Tapd 数据源等配置见 `config.example.yaml` 内注释。调查、修复和独立评审统一使用 Pi；所有角色只认一个模型入口——`agents.roles.<role>.model`（未配置 = `pi.provider` 默认模型），Reviewer 需要独立模型时配 `agents.roles.review.model`。旧版的 `agent`、`codex`、`review.backend` 和 `review.model` 配置不再生效（`review.model` 保留迁移提示，提示改用 `agents.roles.review.model`），保存 Web 设置时会从 `overrides.yaml` 清理。

### 同时修改项目目录和引擎目录

主 `repos[].path` 仍是 Perforce 项目工作区；把一个或多个 Git 仓库放在同一项的
`additional_dirs` 下即可。Pi 通过提示词中的根别名和绝对路径访问附加目录，不需要把工作目录写进 skill 配置。

每个 Bug 开始前，工具要求附加 Git 仓库处于干净状态，并从 `base_branch` 创建分支：
`<主分支>_<作者><yyyyMMddHHmmss>`，例如 `branch_0.7.0_developer20260707171730`。
已经被 Git 跟踪、但会被本地编译反复改写的生成目录可放入 `ignore_paths`。这些路径不会阻塞
干净检查，也不会进入 Agent diff/commit；失败回滚时会原样保留。路径相对 Git 仓库根目录，
目录以 `/` 结尾，也支持 Git glob。不要把源码目录加入此列表。
修复成功后在该分支本地 commit 并切回主分支，但不会 push；失败或取消时仅清理本次工具创建的分支。
调查与结果中的文件使用根别名区分，例如 `project:Source/Game.cpp`、
`engine:Engine/Source/Runtime.cpp`。目录访问范围由提示词、工具白名单和修复范围检查约束，Pi 不提供操作系统级目录沙箱。

MCP 采用注册表配置：所有 `enabled: true` 的 server 都会在 Agent 启动时自动加载，后续增加 MCP 只需在 YAML 追加一项，不需要修改 TypeScript。示例：

```yaml
mcp_servers:
  unreal_mcp:
    enabled: true
    command: 'C:\Python310\python.exe'
    args: ['{repo}\Plugins\UnrealMCP\Python\unreal_mcp_server_advanced.py']
    cwd: '{repo}\Plugins\UnrealMCP\Python'
    disabled_tools: [execute_python]
    read_only_tools: [ping, get_actors_in_level, read_blueprint_content]
    automates_manual_keywords: [场景, 关卡, 蓝图, actor, datatable]

  prefab_mcp2:
    enabled: true
    command: 'C:\Python310\python.exe'
    args: [-m, prefab_mcp2.server]
    cwd: '{repo}\Plugins\UnrealMCP\Python\prefab_mcp2'
    env:
      PYTHONPATH: '{repo}\Plugins\UnrealMCP\Python\prefab_mcp2\src'
    read_only_tools: [lgui_ping, lgui_node_tree, lgui_node_info, lgui_prop_get]
    automates_manual_keywords: [prefab, 预制体, lgui]

  chrome_devtools:
    enabled: true
    required: false
    command: node
    # 每个 Agent 进程只启动轻量 stdio 代理，实际 Chrome 调试连接由官方常驻 daemon 复用。
    args: ['{agent}\\dist\\chromeDaemonProxy.js']
    cwd: '{agent}'
    env:
      CHROME_DEVTOOLS_MODE: managed
      CHROME_DEVTOOLS_CALL_TIMEOUT_MS: '75000'
    enabled_tools: &chrome_read_tools [list_pages, new_page, close_page, navigate_page, take_snapshot, take_screenshot, list_console_messages, get_console_message, list_network_requests, get_network_request]
    read_only_tools: *chrome_read_tools
    startup_timeout_sec: 60
    tool_timeout_sec: 90
```

本地 server 使用 `command/args/cwd/env/env_vars`；远程 Streamable HTTP server 可改用 `url/bearer_token_env_var/http_headers/env_http_headers`。路径和值支持 `{repo}` / `${repo}`（当前 Bug 仓库根）及 `{agent}` / `${agent}`（本工具安装目录）占位符。`enabled` 和 `required` 控制启用与依赖要求；`enabled_tools` 和 `disabled_tools` 控制工具范围；`read_only_tools` 是本项目为调查与 Reviewer 增加的安全白名单。资源关键词直接配置在对应 MCP 的 `automates_manual_keywords`：server 禁用时保持人工门禁，启用后才允许自动处理，因此不必在全局 `manual_keywords` 重复填写。Pi 通过通用代理动态发现和注册工具；非 `required` 服务启动失败时会跳过，不阻塞纯代码 Bug；命中 `automates_manual_keywords` 的资源类 MCP 会在本次任务被**动态提升为必需**，预检失败直接阻塞且不消耗修复重试。含外部诊断链接的 Bug 只会把 `chrome_devtools` 选入本次调查工具集，**不会**把它提升为必需：浏览器不可用时如实记录，并继续按工单文字、附件与源码修复（`worker.ts` 的 required 集合只由关键词匹配结果构成；`repairWorkflow.ts` 也明确把外部页面当作增强证据而非门禁）。TAPD MCP 属于编排器数据源，继续单独配置在 `tapd.mcp`，不会加载给编码 Agent。

`chrome_devtools` 使用项目中固定安装的 `chrome-devtools-mcp`，不会临时联网下载。代理（`src/chromeDaemonProxy.ts`）只启动轻量 stdio 代理，真正的浏览器连接由官方常驻 daemon 持有；同一模式内调查、修复、Reviewer 或下一个 Bug 都会复用该连接，不会重复建立 Chrome 调试连接。

连接模式由 `CHROME_DEVTOOLS_MODE` 选择。两种模式使用**不同的 daemon 会话 id**，因此命名管道与 PID 文件互不干扰，可随时切换而不会互相顶掉（把两者配成同一个 id 会直接报错）：

- **`managed`（推荐，默认配置已启用）**：由 MCP 自己以管道方式启动一个**项目专用、持久 profile** 的 Chrome。它不经过 Chrome 的远程调试授权链路，daemon 存活期间不会反复要求授权。默认 profile 目录是项目内 `.chrome-profile/`（已 gitignore；内含运行期 cookie，**不要提交**），可用 `CHROME_DEVTOOLS_PROFILE_DIR` 指向别处（越出工作区时可能需要授权），用 `CHROME_DEVTOOLS_EXECUTABLE_PATH` 指定 Chrome 可执行文件。它不复制、不读取你日常的 Chrome profile，也不关闭任何 Chrome 安全机制（不使用 `--no-sandbox` 之类旗标）。
- **`attach`**：`--auto-connect` 附着到你日常使用的 Chrome，直接复用已有登录态。代价是受 Chrome 144+ `chrome://inspect/#remote-debugging` 的连接授权约束：该安全确认由 Chrome 控制，不能在本项目中永久绕过，连接断开后需要重新授权一次。

managed 模式的**首次登录**：在普通终端里执行下面两条（只启动浏览器，不会拉取或处理任何 Tapd 工单）：

```powershell
cd C:\AppProject\TapdBugFixAgent
$env:CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = '1'   # 只用本地已安装版本，不做任何联网检查
# 1) 拉起（或重启）managed daemon，并打开可见的专用 Chrome
node node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools.js start --session-id 74617065 --no-headless --user-data-dir="$PWD\.chrome-profile"
# 2) 确认连得上
node node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools.js list_pages --session-id 74617065
```

第 1 条会打开一个**项目专用**的 Chrome 窗口，在其中人工登录 CrashSight / Sentry 等目标站点一次即可。登录态保存在 `.chrome-profile/` 里，之后的任务无需再登，直到 cookie 过期或站点主动要求重新验证。

三个必须注意的点：`--session-id 74617065` 必须与代理的 managed 会话 id 一致，否则会另起一个 daemon 和另一个浏览器，代理仍然连不上；`--no-headless` 必须**显式**给出——官方 CLI 在没有连接类旗标时会把 `headless` 默认为 true，不给就看不到窗口、没法登录；`--user-data-dir` 一旦提供，官方 CLI 的 `isolated=true` 默认就不会生效（该默认的前提是 `userDataDir === undefined`），所以两者不冲突，不会退化成临时 profile。另外，`chrome-devtools start` 发现同 session id 的 daemon 已在运行时**会先停掉它再重启**，因此请在开始处理队列之前执行。

专用 Chrome 冷启动可能较慢，首次调用失败可重试一次。

单次 daemon 调用预算由 `CHROME_DEVTOOLS_CALL_TIMEOUT_MS` 控制（默认 75000ms），必须**早于**上面的 `tool_timeout_sec`（90s）结束：一份预算同时覆盖「daemon 就绪 + 工具调用」，这样超时得到的是带真实原因的 `isError`，而不是外层 MCP 那条笼统的「调用超时」。页面确实更慢时，请同步调大这两个值。

不要改用 `--isolated`：那是临时 profile、浏览器关闭即清空，每次都需重新登录；它既不是避开授权的必要条件，也会丢掉 managed 模式的持久登录态。调查阶段会尝试读取外部诊断链接；登录失效、权限不足或页面不可达时如实记录，但只要标题、描述、附件或源码已经能定位相关代码，就继续修复。

Agent 工具调用总次数和同一工具次数均不设置固定上限，`find`、`read`、`grep` 等可按调查需要反复使用；只由各阶段总超时兜底。只读调查最长使用 10 分钟搜索，随后用最多 3 分钟根据已有轨迹强制收敛；超时或结构化输出不完整会自动重试，不再误标为 `needs_info`。进入 `needs_info` 的只有三类「自动重试也解决不了」的情况，且都不消耗修复尝试次数：只读 Agent 明确无法根据标题、描述及现有代码定位任何相关模块、文件或符号；`repair_contract.open_questions` 里仍有影响修复方向的业务未决问题；现有代码疑似已包含该修复、修复前失败基线不可确认（Agent 以「基线不可确认：」开头写入 `blocked_reasons`）。无法运行游戏/编辑器/自动化等纯验证限制写入外层 `verification_limitations`，既不阻断修复，也会如实进入实施提示、评审提示、changelist 描述与审计证据，绝不当成“已验证”。

Pi 的 `grep` / `find` 通过本地扩展默认搜索源码目录，编码阶段默认搜索计划文件所在目录；可显式指定相关路径扩大范围。递归搜索排除生成目录、二进制与 Windows `nul` 文件，每次最多 30 秒并保留部分结果；Shell 搜索也设置 30 秒单次超时，编译验证不受此限制。调查和收尾都超时时，会同时保存两段错误和轨迹。编码超时后的重试在工单上下文一致且计划路径仍有效时沿用调查检查点，由编码阶段重新核对源码；人工重试保留证据。独立评审发现的问题仍须修正，不因超时或重试而跳过。

调查未完成时，失败证据保存已调用工具、已有观察、未确认问题和压缩轨迹。工单内容与工作目录一致时，下一次只读调查直接续查缺口；工单变化时重新核对，不把旧断点当成已证实根因。Pi 收尾仅整理已有证据，使用精简提示并关闭该收尾调用的推理；调查、编码和评审的推理设置不变。每 30 秒记录等待响应、推理、输出或工具执行状态及计数，超时报错附上这些元数据，不记录推理内容。未完成调查会在管理台明确显示，不能当成修复成功。

Unreal 资源写入前仍须确认编辑器打开的工程就是该 P4 workspace；Agent 会比较 MCP 返回的项目根，发现不一致时停止写入。

### .env

```ini
TAPD_ACCESS_TOKEN=...      # Tapd 个人设置 → 个人访问令牌
WEB_TOKEN=...              # 管理台鉴权（URL 带 ?token= 或页面弹窗输入）
# P4PORT/P4CLIENT/P4USER/P4PASSWD  # 也可放这里，优先级高于 config.yaml
```

> 改连接配置不必动文件：管理台顶部 **⚙ 设置** 可在线编辑 Pi 模型与 p4/tapd 连接项，保存写 `overrides.yaml`（优先级最高）。

## 运行

```bash
npm run dev -- list            # 只读：列出分配给我的 bug（按优先级）
npm run dev -- mcp-tools       # 调试：打印 Tapd MCP 发现的工具清单
npm run dev -- run --once      # 无界面：处理最高优先级的 1 个 bug（首次接入先跑这个试试）
npm run dev -- serve           # Web 管理台 + 工作线程（日常用法）

# 生产（构建后常驻）
npm run build && npm start
```

CLI 通用选项：`--config <path>`、`--db <path>`、`--host` / `--port`（serve）。

**无人值守用 `serve`，不要用 `run --once`。** `--once` 只处理 1 个 bug 就退出，想连续无人值守就得靠外部计划任务反复拉起，进程重启之间的状态衔接反而更难保证；`serve` 是常驻进程，配合进程守护（Windows 服务 / nssm / systemd）即可长时间自跑。

需要说明的边界：本轮**没有**跨进程心跳，因此 CLI/编排进程本身崩溃时，当时处于 `in_progress` 的单不会自动被回收，需要重启后人工确认（人工重试会保留已有轨迹和调查检查点）。这一限制是有意保留的，不要把它当成已实现能力。

单个 bug 的处理流程：拉取队列（≤1 次/分钟缓存）→ 自动修复准入评分 →
只读调查 Agent（代码浏览工具；Unreal 资源 Bug 额外挂只读 MCP 工具）→ 精确同步 `planned_files` →
修复 Agent 最小修改（资源写入仅通过 MCP）→
P4 范围门禁 → `verify_cmds` 机器验证 → 独立只读 Reviewer → Reviewer finding 定向修正/复审 →
生成 pending changelist → Tapd 评论（不改状态）。失败按 `max_attempts` 自动重试并携带测试、文件和评审证据。

整体执行架构参考 OpenAI 的 [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform) 与
[开源 Codex harness](https://github.com/openai/codex)：由宿主应用提供业务上下文、边界、状态与审批，Agent harness
负责持续任务、工具调用、进度和失败处理。Prompt 设计同时参考 Codex 官方公开的
[prompting/workflows](https://developers.openai.com/codex/workflows) 与 [code review](https://developers.openai.com/codex/code-review) 原则；
不复制或依赖任何产品的隐藏 system prompt。三个阶段使用不同的执行契约：

- **调查**：先读仓库规则和相关测试，区分观察事实、推断和未验证假设，比较候选根因并给出排除依据；证据不足则停止。
- **实施**：编辑前复核调查结论，只做最小完整补丁，按“专项复现 → 最小相关测试 → 配置验证”执行并如实报告结果。
- **评审**：只读检查根因覆盖、范围、回归测试和关键错误/生命周期路径；只报告有证据、失败场景和明确修法的 actionable findings。

### 准确率门禁

- **结构化 Bug 上下文**：从 TAPD 原始字段整理复现步骤、预期/实际结果、环境、日志、评论和附件。
- **图片/视频证据**：通过 TAPD MCP 把描述内图片和附件换成 300 秒临时 URL；Pi 会在请求层发送原生图片/视频内容块，不下载媒体，也不按模型名称硬编码能力。不支持该格式或抓取失败时自动降级为普通 URL 文本。
- **自动修复准入**：描述过短、缺少复现信号时进入 `needs_info`；可由已启用 Unreal MCP 处理的资源类进入自动调查，其余资源类进入 `manual_only`；所有业务代码均按同一流程调查和修复，不按协议、账号等关键词分类拦截。
- **严格验证**：未配置 `verify_cmds` 时只能生成 `candidate`，不会标记为“已验证”。
- **范围限制**：默认最多 8 个文件、500 行 diff，超限转失败/人工分析，避免无关大改。
- **计划白名单**：实际 P4 改动必须属于只读调查阶段声明的 `planned_files`，计划外文件会拒绝候选。
- **工作区隔离**：default changelist 中若有无法归属当前 Bug 的遗留文件，任务进入 `blocked_workspace`，不调用 Agent、
  不消耗重试次数，也绝不把遗留改动混入当前补丁。大型专用工作区默认不做全目录 reconcile；Agent 漏掉 `p4 edit/add`
  时只对调查阶段声明的 `planned_files` 执行精确 reconcile。
- **独立评审**：Reviewer 强制只读；high/medium finding 会交回 Fixer，修正后重新验证和复审。
- **真实结果回流**：人工可记录原样接受、修改后接受、具体拒绝原因和 reopen，管理台展示真实准确率。

## Web 管理台

![运行效果](web_run.jpg)

- **控制**：开启 / 暂停 / 恢复 / 关闭；标题旁显示运行版本（改代码后重启才会变，用于辨认旧进程）
- **列表**：按状态分组（处理中置顶），显示优先级 / changelist / 尝试次数；`⚠不在Tapd列表` 标记本地有记录但
  已不在"分配给我"列表的 bug（可重试，Tapd 已删除的会自动跳过并留痕）
- **详情抽屉**：Agent 实时进度（终端形式）、生成的 changelist 描述、修改文件、需人工资源、失败原因、
  自动重试记录、只读调查结论、机器验证、Reviewer findings、操作日志
- **人工结论**：在候选详情记录原样接受 / 修改后接受 / 根因错误 / 定位错误 / 回归 / 过度修改 /
  未解决 / reopen；不会自动 submit，也不会修改 TAPD 状态
- **质量指标**：顶部显示候选精确率、候选原样接受率、候选反馈覆盖率、候选覆盖率和端到端有效率；`GET /api/quality/metrics` 可供监控系统采集
- **批量操作**：
  - **↻ 重试全部失败**：所有失败任务重置为待处理并入队
  - **⟳ 清除并重新同步**（仅非运行状态可用）：清空本地任务状态和事件，从 Tapd 强拉最新列表重置为待处理。
    人工反馈与质量指标会保留；p4 上已生成的 pending changelist 不受影响，但 Tapd 上仍是 new 的旧单会被重新处理
- **单条操作**：重试 / 跳过（正在处理的重试/跳过会先中断当前尝试）
- **⚙ 设置**：在线编辑连接配置（写 overrides.yaml）
- token 错误会弹输入框让你当场修正并记住，不再是死胡同

任务列表「处理中 N」分组标题栏右侧跟随当前处理中的 bug（SSE 每 2 秒推送），展示**当前阶段**与该阶段**正在实际执行的模型**
（`/api/status` 的 `current_stage`：`current_stage` / `current_stage_label` / `current_model`）。
模型解析与真正调用 pi 时同源（`agents.roles.<role>.model || pi.provider` 默认模型）：
调查 / 实施阶段的 recovery 收尾子调用期间会同步切到 recovery 角色模型（阶段标签不变），跑完随即还原；
准备、准入、机器验证等不调用模型的阶段 `current_model` 为空串，前端显示「—」；没有处理中任务时该分组及其右侧状态整块不渲染。
日志只由服务端 PowerShell 输出，页面不再重复渲染日志面板。

## 工作原理

```
Tapd ──MCP(个人令牌)──> Orchestrator(worker) ───────────> Pi subprocess
Tapd ──REST(API账号)──>       │        │
      ^                       │        └── reconcile/edit/add ─> Perforce workspace
      └── 评论回写(不改状态)   │
                              Web 管理台 (Express + SSE)
```

### 多 Agent 编排（角色层）

本项目的编排是 **两层**，不是把 DSH 的 agent preset 复制进来：

```text
第 1 层  Orchestrator = worker.ts 状态机
         │  只做三件事：维护状态机 / 派发单阶段调用 / 按事实验收（P4、Git、验证命令、评审结论）
         │  自己不做代码修改，不替 Agent 判断根因
         └── 派发 8 个调用点，每处都显式标注角色（role）
第 2 层  子 Agent = `pi --print --mode json` 子进程（每次调用一个全新上下文，不共享会话）
            只做单一阶段：调查 / 实施 / 评审 / 恢复
```

- **职责边界**：Orchestrator 负责状态机、派发与验收；子 Agent 只负责单一阶段。
  阶段顺序、phase 取值、错误类型、P4/Git 流程与 provider 冷却语义都由 Orchestrator 决定，角色层不参与。
- **两层拓扑（文档约束，非运行时开关）**：`src/agentRoles.ts` 的
  `SUB_AGENT_ORCHESTRATION_DEPTH = 1` / `ORCHESTRATION_MAX_DEPTH = 2` 只是把上述拓扑写进代码常量，
  并让每次调用的审计带上 `orchestration_depth: 1`。Pi 子进程没有任何回调本编排器的入口
  （没有把 worker 暴露成 Pi 工具 / MCP / 扩展），因此**不存在子调用递归**；这里不宣称运行时强制执行。
- **并发边界**：只读角色（investigation / review）之间的并发是**未来边界**，当前全部串行；
  **实施、P4、Git 与交付永远保持串行**，不引入任何并行写入。
- **可审计**：`agent_input` / `agent_usage` 审计事件带 `role`、解析后的 `model`、`timeout_s`、
  `tools`、`sandbox` 与 `prompt_hash`；进度区单独一行显示 `Pi: 角色 role=…`。
  审计只落 prompt 的哈希，**不落 prompt 明文**。尝试元数据里另有 `agent_roles` 覆盖快照。

角色 ⇒ 调用点与阶段（`phase` 是审计里的旧字段，取值保持不变）：

| 角色 | 语义 | 调用点 | audit phase |
| --- | --- | --- | --- |
| `investigation` | 只读调查：根因、证据、最小修改范围 | 主调查、补充核查、范围复核 | `investigation` |
| `implementation` | 首轮实施写入 | 编码阶段首次调用 | `implementation` |
| `review` | 独立只读评审 | Reviewer（含修正后的二次评审） | `review` |
| `recovery` | 恢复/修正 | 无工具收尾、编码预算收尾、Reviewer 拒绝后的定向修正及其收尾 | `investigation` / `implementation` / `correction` |
| `coordinator` | 任务规划与最终汇总：只读无工具，只产出文字，不参与任何决策 | 主调查**之前**的计划建议、最终交付**之前**的汇总文案 | `coordinator_plan` / `coordinator_summary` |

配置在 `config.yaml`（**整段省略即与旧配置行为完全一致**，这是默认形态）：

```yaml
agents:
  roles:
    investigation: { model: "", timeout_s: 1800 }   # 空模型 = 沿用 pi.provider 的模型
    implementation: { model: "", timeout_s: 2400 }
    review: { model: "review-role", timeout_s: 1200 }
    recovery: { timeout_s: 600 }                    # 收尾/修正仍受既有派生上限约束
    coordinator: { model: "" }                      # 可选：写上才启用；时限默认 min(角色时限, 120s/90s)
```

- 只支持 `model` 与 `timeout_s`：这是当前调用结构下能安全接入的两项覆盖。
  `sandbox` / `tools` 是各阶段的**硬约束**（只读调查必须只读、收尾必须无工具），不接受配置放宽；
  写进配置会只作为启动告警提示。
- 别名 `investigator` / `implementer` / `reviewer` 自动归一到规范角色名；
  未知角色名或非法 `timeout_s` 只出配置告警，不阻断启动、也不改变默认行为。
- **模型优先级**：显式调用参数 > `agents.roles.<role>.model` > `pi.provider` 默认。
  这是唯一的模型入口，`review` 角色也一样（旧的 `review.model` 已移除，Reviewer 要独立模型只能配 `agents.roles.review.model`）。
  裸模型名会自动补 `provider/` 前缀。
- **时限优先级**：显式调用参数 > `agents.roles.<role>.timeout_s` > 该阶段原有预算。
  收尾/补查等派生调用额外套用 `min(角色时限, 既有派生上限)`，**不会放大收尾预算**。
- 角色模型只在 `config.yaml` 的 `agents.roles` 里配置（Web 设置页不提供角色模型入口，
  它只编辑 Pi provider、p4、tapd 连接项）；设置接口也不再读写已移除的 `review.model`。
- 每个角色的职责、读写/工具边界、典型调用点，以及 `model` / `timeout_s` 的回退规则，
  逐条写在 `config.yaml` 与 `config.example.yaml` 的 `agents.roles` 段注释里（尤其 `recovery`
  覆盖三类调用、有意不配 `timeout_s`），本文表格只给对照摘要。

### coordinator（计划建议 + 最终汇总）

`coordinator` 是唯一**不参与决策**的角色：只读、无工具（`tools: []` + `sandbox read-only`）、不挂任何 MCP，
在一次处理里只被调用两次。

> **需要显式启用**：它是本次改造新增的调用点，会在既有调用序列里插入两次只读调用，
> 因此只有配置里出现 `agents.roles.coordinator` 且解析出至少一个有效字段（`model` 或 `timeout_s`）才生效；
> 不写它 = 调用序列与改造前逐字一致（不产生任何额外模型调用）。示例配置见 `config.example.yaml`。
> 注意 `coordinator: {}` 这类「没有任何有效字段」的写法会被角色层按既有规则丢弃（空值不产生行为差异），
> 请至少写上 `model:`（留空即沿用 pi.provider 默认模型）。

- **计划建议（主调查之前）**：根据工单与准入上下文产出一份调查方向建议，作为调查 prompt 的一段附加文字。
  它拿不到仓库内容（没有工具），因此措辞上明确标注「未经过代码核实、仅供参考、不是硬约束」；
  文件白名单（`planned_files`）、阶段推进、P4/Git 操作、验证与评审结论仍全部由编排器与调查 Agent 的证据链决定。
- **最终汇总（交付之前）**：编排器先把**已经确定的事实**（Agent 输出、P4/Git 改动清单、机器验证结果、
  独立评审结论、人工资源项）整理成 facts 交给它，它只负责组织文字。产出以「协调者补充说明（未参与任何决策，
  不覆盖上述测试/文件/评审事实）」的**附加段落**追加到交付描述末尾，`result.summary` 与所有结构化事实保持不变，
  交付分类（`candidate` / `verified` / `review_pending`…）也不因它的文字改变。
- **失败一律降级**：超时、异常退出、输出不是**严格 JSON**（只接受 `FINAL_RESULT:` 后或整段输出的单个 JSON 对象，
  不做「从文本里猜 JSON」的宽松解析）、字段类型不符或为空——都只是「本次没有建议」，记一条 warn 事件后按原流程继续。
  **唯一例外是人工取消**：`AgentCancelledError` 原样向上传播，整单终止并回到待处理队列，不会被降级成「没有建议」继续跑。
- **时限**：`min(agents.roles.coordinator.timeout_s, 120s)`（计划）与 `min(..., 90s)`（汇总），
  因此配置只能收紧、不会放大；未配置时用这两个派生上限。
- **审计**：`coordinator_plan` / `coordinator_summary` 事件带 `role`、`model`、`timeout_s` 与
  `plan_hash` / `summary_hash`（正文会进 prompt 与交付描述，与 `agent_input` 同口径只落哈希，不落正文）。

与 DSH preset 的区别：DSH 的 agent preset 是「一个进程内的多角色会话编排」；本项目是
**Pi 子进程编排**——每个阶段独立 spawn 一次 `pi`，上下文不跨阶段残留，编排状态保存在 SQLite 与 P4/Git 事实里。
因此角色层只是把原先隐式的调用意图显式化、可配置化、可审计化，而不是引入新的调度引擎。

**新状态机**：
```text
pending → in_progress
  ├─ provider_unavailable      # 外部模型网关不可用：非终态，全局冷却到期后自动重试
  ├─ needs_info / manual_only
  ├─ manual_review             # 候选未完成：保留已有 changelist 和具体失败原因
  ├─ blocked_workspace         # default changelist 有无法归属的遗留文件，清理后人工重试
  ├─ candidate                 # 有补丁但未配置机器验证
  ├─ candidate_partial         # 候选代码 + 人工资源项
  ├─ verified                  # 机器验证通过，未启用独立评审
  └─ review_pending            # 机器验证和独立评审通过
       ├─ accepted
       ├─ accepted_modified
       ├─ rejected
       └─ reopened
```

失败未耗尽重试回 `pending`；Tapd 上已删除的单自动转 `skipped` 留痕。
开发阶段只维护当前协议，不保留旧接口、旧字段兼容分支或旧数据库自动迁移。

### provider 不可用时的无人值守行为

外部模型网关不可用不会把工单标成修复失败：`provider_unavailable` 是非终态，可自动重试，也不消耗普通修复尝试次数。

- **故障分类**（`agent.ts`）：按 `quota`（余额/额度/欠费）→ `auth`（鉴权）→ `transient`（限流、网络抖动、5xx）的顺序判定。顺序是刻意的——欠费报文里常带 429/限流字样，先按限流处理会退化成短期退避，把队列反复喂给已经不可用的 provider。
- **全局持久冷却**（`state.ts`）：冷却截止时间跨进程持久化，重启后不会立刻把整批工单再撞一遍同一个故障 provider。只存有界截止时间，到期自动探测一次，不会永久静默停机。
- **有界退避**（`worker.ts`）：`transient` 从 30s 起、每失败一次翻倍、10 分钟封顶；`quota` / `auth` 从 15 分钟起、2 小时封顶。
- **熔断是全局的，不按模型细分**：一次 provider 故障触发的是该 provider 的全局冷却，审查阶段用的是同一个 provider，因此 **review 模型调用同样被暂停**。不做 per-model 排队或分模型退避——同一个不可用网关下按模型细分只会让队列更碎、恢复更晚。
- **冷却期间不领取任何新任务**；工作循环按分钟级休眠而非忙轮询，以便及时感知人工提前解除。
- **人工重试**是明确的人工恢复信号：提前解除全局冷却并清零退避计数，从最短间隔重来，不会出现「点了重试却什么都没发生」。
- **历史误阻塞的恢复**（`worker.ts`）：仅当失败原因是显式的 provider 错误标记、且不含任何 Git / P4 / 工作区清理证据时，才把旧版本误标成工作区阻塞的单在重启后放回队列。方向性取舍是「宁可漏恢复，不可误恢复」——真实工作区问题继续停在 `blocked_workspace`，不会被放进自动队列污染下一个补丁。
- **不会自动修复的**：账户余额耗尽与鉴权失效属于外部条件，代码不会也无法代为恢复，需要人工补充额度或更换 Key；冷却到期后只做一次重新探测并如实记录结果。
默认使用 `tapd_agent_v3.db`；状态库在头部写入 schema 版本（`user_version`，当前 3），版本不符或含旧架构表时
拒绝启动并原样保留旧文件：启动只做只读 schema 探测，不读取历史业务数据，也不改写文件内容——
重新开始采集时直接让新默认文件在下次启动时创建即可。
只有绑定具体候选版本的人工反馈会计入准确率指标并进入经验检索，旧库中无法关联候选的历史反馈不再参与统计。
旧库文件（如 `tapd_agent_v2.db`）保留在原处不动，仅不再被本工具读取业务数据。

**P4 安全**：Agent 只允许 `p4 edit / add / delete`（submit / revert / sync / change 写入 prompt 禁止）；
工具侧只收集 **default changelist** 的文件生成 pending，绝不动其它编号 changelist；
每个 Bug 先进行只读调查，再用 `p4 sync --parallel=threads=4,min=10 <planned_files...>` 仅同步调查声明的
`project:` 文件；纯 Git 修改不执行 P4 sync，reconcile 兜底也只扫描 `planned_files`。
精确同步单次默认超时 10 分钟；超时会进入 `blocked_workspace` 且不消耗 Bug 重试次数，只有网络抖动、
文件占用等瞬时错误会在 P4 层重试。
个人本地 skill 可在 P4 工作区根目录的 `.p4ignore` 中忽略 `.agents/skills/`、`.agent/skills/`，
并配置 `p4.ignore: .p4ignore`（或环境变量 `P4IGNORE=.p4ignore`）。忽略只影响 P4 跟踪，Pi 仍可加载这些 skill。

**团队 skill**：Pi 后端自动挂载仓库下的 `.agents/skills` / `.agent/skills`（存在才挂）——
同事放在版本库里的 skill 修复 Agent 也能用。目录结构 `<名字>/SKILL.md`（frontmatter 需
name + description，文件必须无 BOM）。可用 `pi.skill_dirs` 覆盖。

**修复守则**：`prompts/defensive-patterns.md` 启动时读取并注入实施 Prompt。它按“检查点 / 必须保持的不变量 /
常见坏修复”整理根因、异步竞争、取消与清理、重试幂等、状态机、缓存、协议、边界输入、验证诚实性和 diff 范围；
只要求 Agent 应用与当前 Bug 有关的条目。删文件即停用。

## 历史 Bug 离线评测

使用冻结的 JSON 数据集与 JSONL 配对试验比较模型或 Prompt；命令仅读取评测记录，不连接 P4、模型或 TAPD：

```powershell
npm run dev -- eval --dataset docs/accuracy-development-cases.json
npm run dev -- eval --dataset evaluation/frozen.json --result A=evaluation/a.jsonl --result B=evaluation/b.jsonl
```

不传结果文件时只校验数据集。传入结果时，校验初始版本、预算、配对次数、独立工作区身份和答案泄漏，输出 top-1 接受率、候选/反馈覆盖率、原样接受率、耗时和成本。未产出候选仍计入分母，未知成本保持 null。

唯一数据格式为 `EvaluationDataset` / `PairedTrial`，字段与使用边界见 [实施说明](docs/accuracy-implementation.md)。历史标签缺少源码/资源版本时只能做标签分析，不能声称完成历史重放。

**changelist 描述**：首行 `【b<短号>】<标题>`（= Tapd「复制Bug单信息」按钮的文本，可过 swarm 校验；
短号由完整 id 推导），后附单号链接 / 修复说明 / 修改文件 / 需人工资源 / 验证结果。

## 常见问题

**点重试没反应？** 早期版本列表只显示 Tapd 当前列表，已不在列表的 bug 重试后无人处理——已修复（本地记录可见可处理）。
若整页无响应看浏览器控制台；token 失效会弹输入框。

**列表里的 bug 不在了还显示？** 标 `⚠不在Tapd列表` 的是本地历史记录（可重试）。Tapd 上确认已删除的单，
worker 轮询时自动转跳过并写明原因。

**怎么确认跑的是新代码？** 标题旁版本号（如 v0.3.2）。改完代码记得重启进程——旧进程会一直占着端口。

**修复好的单子又出现在队列？** 工具不改 Tapd 状态，所以单子状态仍是 new；若用「清除并重新同步」，
这些单会重新处理。已人工关闭（resolved 等）的单不会。

**开发**：`npm test`（vitest）；源码在 `src/`，构建产物 `dist/`（含 `prompts/`）。

## 准确率改进

新流程按尝试保存补丁与人工反馈，调查必须给出业务验收条件，并检索相关历史经验。管理台只显示按候选版本统计的完整候选精确率、原样接受率和覆盖率（旧的人工接受口径已随旧数据库兼容逻辑一并移除）。编译通过与行为验证分别记录。

测试接入统一配置在本工具的 `config.yaml`，不向目标仓库添加配置。已有 `tests`、`qa` 或独立测试工程通过 `verify_cmds` 的命令、执行目录和超时直接复用，详见 [测试接入配置](docs/testing-configuration.md)。

行为测试配置、14例开发基线和严格配对评测用法见 [实施说明](docs/accuracy-implementation.md)，调研依据见 [设计方案](docs/accuracy-improvement-2026-09-18.md)。构建并重启服务后新流程生效；可选的 `behavior_checks` 用于逐条记录专项断言的修复前后结果。

行为测试按目录自动发现，适用源码由脚本的 `export const files` 声明。新增/删除 `.mjs` 从下一次修复生效；无需在配置中逐项维护文件。停用、改名和脚本模板见 [行为测试维护指南](behavior-suites/README.md)。

## 风险提示

自动修真实 Bug 有风险（语义误判、误改）。保持 `review` 模式：代码停在 pending changelist，
人工 review 后 submit；确认无误再去 Tapd 关单。
