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

provider 名称默认 `gateway`，认证默认使用 `Authorization: Bearer`，请求使用 Anthropic Messages 协议，网关需支持该协议。模型注册由项目自动完成。若希望把密钥放在环境变量中，可省略 `api_key` 并设置 `PI_API_KEY`。上下文窗口等高级参数可按模型需要覆盖。

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

Pi 模型、Web token、Tapd 数据源等配置见 `config.example.yaml` 内注释。调查、修复和独立评审统一使用 Pi；`review.model` 可单独指定评审模型，留空沿用修复模型。旧版的 `agent`、`codex` 和 `review.backend` 配置会被忽略，保存 Web 设置时会从 `overrides.yaml` 清理。

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
      CHROME_DEVTOOLS_SESSION_ID: '74617064'
    enabled_tools: &chrome_read_tools [list_pages, new_page, close_page, navigate_page, take_snapshot, take_screenshot, list_console_messages, get_console_message, list_network_requests, get_network_request]
    read_only_tools: *chrome_read_tools
    startup_timeout_sec: 60
    tool_timeout_sec: 90
```

本地 server 使用 `command/args/cwd/env/env_vars`；远程 Streamable HTTP server 可改用 `url/bearer_token_env_var/http_headers/env_http_headers`。路径和值支持 `{repo}` / `${repo}`（当前 Bug 仓库根）及 `{agent}` / `${agent}`（本工具安装目录）占位符。`enabled` 和 `required` 控制启用与依赖要求；`enabled_tools` 和 `disabled_tools` 控制工具范围；`read_only_tools` 是本项目为调查与 Reviewer 增加的安全白名单。资源关键词直接配置在对应 MCP 的 `automates_manual_keywords`：server 禁用时保持人工门禁，启用后才允许自动处理，因此不必在全局 `manual_keywords` 重复填写。Pi 通过通用代理动态发现和注册工具；非 `required` 服务启动失败时会跳过，不阻塞纯代码 Bug；但当前 Bug 含诊断链接或命中某个资源关键词时，对应 MCP 会被动态视为必需，预检失败直接阻塞且不消耗修复重试。TAPD MCP 属于编排器数据源，继续单独配置在 `tapd.mcp`，不会加载给编码 Agent。

`chrome_devtools` 使用项目中固定安装的 `chrome-devtools-mcp`，不会临时联网下载。项目代理会自动启动并复用同一个官方 daemon；因此调查、修复、Reviewer 或下一个 Bug 即使重新创建 stdio MCP，也不会重新建立 Chrome 调试连接。首次使用（以及 Chrome、Windows 或 daemon 重启后）需在 Chrome 144+ 的 `chrome://inspect/#remote-debugging` 开启远程调试，并在 Chrome 弹出的连接授权中允许一次；daemon 与 Chrome 持续运行期间后续任务无需重复授权。该安全确认由 Chrome 控制，不能在项目中永久绕过。不要改成 `--isolated`，否则会启动不带现有登录态的临时浏览器。调查阶段会尝试读取外部诊断链接；登录失效、权限不足或页面不可达时如实记录，但只要标题、描述、附件或源码已经能定位相关代码，就继续修复。

Agent 工具调用总次数和同一工具次数均不设置固定上限，`find`、`read`、`grep` 等可按调查需要反复使用；只由各阶段总超时兜底。只读调查最长使用 10 分钟搜索，随后用最多 3 分钟根据已有轨迹强制收敛；超时或结构化输出不完整会自动重试，不再误标为 `needs_info`。只有只读 Agent 明确无法根据标题、描述及现有代码定位任何相关模块、文件或符号时，才进入 `needs_info`。

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

底部 Agent 输出区跟随当前处理中的 bug（SSE 每 2 秒推送），分割线可拖拽调高度。

## 工作原理

```
Tapd ──MCP(个人令牌)──> Orchestrator(worker) ───────────> Pi subprocess
Tapd ──REST(API账号)──>       │        │
      ^                       │        └── reconcile/edit/add ─> Perforce workspace
      └── 评论回写(不改状态)   │
                              Web 管理台 (Express + SSE)
```

**新状态机**：

```text
pending → in_progress
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
