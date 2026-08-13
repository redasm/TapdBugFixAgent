# TapdBugFixAgent

自动从 Tapd 拉取分配给你的 Bug，按优先级一个一个交给 **pi 编码 Agent**（`@earendil-works/pi-coding-agent`，
以子进程方式调用，自主完成定位、编辑、测试）修复；修复结果生成 **Perforce pending changelist**（描述由
Tapd bug 单信息自动生成），并通过一个 **Web 管理台** 提供开启 / 关闭 / 暂停 / 恢复、查看已修改列表、
生成描述、无法修改原因等能力。

涉及 **prefab / 表格等二进制资源**的修改不会强行改、不会卡住：Agent 会把它们列入「需人工处理资源」，
记录在 pending changelist 描述和管理台里，人工在编辑器里处理即可。

纯 TypeScript 实现（Node ≥ 20），SQLite 状态库，无 Python 依赖。

## 架构

```
Tapd ──MCP(个人访问令牌)──> Orchestrator(worker) ──subprocess──> pi 编码 Agent
 Tapd ──REST(API账号)───>   │  │                              │
      ^                    │  └─ p4 edit/add ──────────────▶ Perforce workspace
      └──── 评论/状态回写    │
                            │
                  Web 管理台 (Express + SSE)  ←—— 启停/暂停/恢复/查看
```

Tapd 接入支持两种后端（`config.yaml tapd.backend`）：
- **`mcp`（推荐）**：通过 Tapd MCP Server 接入，用**个人访问令牌** `TAPD_ACCESS_TOKEN`（个人设置里即可创建，
  无需公司 API 账号权限、**无需托管**）。两种传输：
  - `stdio`（默认推荐）：本地 `npx -y @xihe-lab/tapd-mcp-server`（用 Node 跑官方包，无需 Python 3.13）
  - `streamable-http`（可选）：填腾讯云托管 MCP 的专属连接地址 `tapd.mcp.url`
  - 已内置官方真实工具名映射（`tapd_get_bugs` / `tapd_update_bug` / `tapd_create_comment`），开箱即用；
    `npm run dev -- mcp-tools` 可随时核对
- **`rest`**：直接调 Tapd OpenAPI（`api_user`/`api_password`，需 API 账号权限）

- `src/worker.ts`：受控工作线程，按控制态（stopped / running / paused）消费 bug 队列
- `src/tapd.ts` / `src/tapdMcp.ts`：REST / MCP 后端（接口对齐，可插拔）
- `src/p4.ts`：p4 命令封装（sync / opened / diff / reconcile / change-spec / 创建 pending changelist）
- `src/agent.ts`：pi 适配器（spawn `pi --mode json`，解析 JSONL 事件流做实时进度，支持取消/超时杀进程树），
  统一结构化输出（`FINAL_RESULT:` 标记）
- `src/descgen.ts`：pending changelist 描述生成（含「需人工处理资源」段）
- `src/verify.ts`：验证门（opened 检查 / reconcile 兜底 / 测试命令）
- `src/state.ts`：SQLite 状态库（control / jobs / events，bug_id 全程字符串避免 >2^53 精度丢失）
- `src/web/`：Express 管理台 + 单页前端（SSE 实时刷新）

## 状态机

```
pending → in_progress
        → resolved     # 代码改完 + 验证过 + pending changelist 已生成
        → partial      # 代码改完 + 部分资源需人工（描述已记录）
        → manual_only  # 纯资源修改（只记录 + Tapd 评论，不建 changelist）
        → failed       # 重试耗尽后失败，记录原因与失败证据，不自动重试
        → skipped      # 人工跳过

in_progress → pending  # 处理失败但未耗尽重试次数（自动重试），或人工暂停/关闭
```

## 安装与配置

```bash
npm install
npm install -g @earendil-works/pi-coding-agent     # pi 编码 Agent（以子进程方式调用）

cp config.example.yaml config.yaml   # 填写 workspace_id / owner / 仓库映射 / p4
cp .env.example .env                 # 填 TAPD_ACCESS_TOKEN（或 API 账号）/ P4*
```

### 前置条件

1. **Tapd 凭据（二选一）**：
   - 推荐：**个人访问令牌** `TAPD_ACCESS_TOKEN`（Tapd 个人设置 → 个人访问令牌 创建），配 MCP 后端（本地 stdio，无需托管）
   - 或：**API 账号** `api_user` / `api_password`（个人设置 → API账号 创建），配 REST 后端
2. **workspace_id**：以 API/MCP 返回为准（或从 bug 单链接 `bug_<workspace_id>...` 前缀确认）
3. **P4 client**：为 Agent 建一个**专用 client workspace**（如 `tapd-agent_<你>`），`p4` 命令需在 PATH 中
4. **仓库映射**：`config.yaml` 的 `workspaces[].repos[]` 指向本地 p4 workspace root
5. **pi 鉴权**：pi 0.74.2 **不读** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，需单独配置（任选其一）：
   - 环境变量 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_OAUTH_TOKEN`），或
   - 先手动跑一次 `pi /login` 做 OAuth 登录
   - 走自定义中转/代理：在 `~/.pi/agent/models.json` 里定义带 `baseUrl` 的 provider（`apiKey` 可填环境变量名，
     `authHeader: true` 即 `Authorization: Bearer` 协议）。示例见 `config.example.yaml` 顶部注释。

## 使用

```bash
# 只读检查：列出"分配给我的"待处理 bug（按优先级排序），不修改任何东西
npm run dev -- list

# 调试：连上 Tapd MCP 并打印发现的工具清单（确认工具名，必要时填 config 的 tool_map）
npm run dev -- mcp-tools

# 无界面单步：处理最高优先级的一个 bug（测试用）
npm run dev -- run --once

# 启动 Web 管理台 + 工作线程
npm run dev -- serve
# 打开 http://127.0.0.1:8080 ，点「开启」开始自动处理

# 构建 + 全局命令（装好 npm i -g 或 npm link 后）
npm run build && tapd-bugfix serve
```

管理台操作：**开启 / 暂停 / 恢复 / 关闭**、按状态筛选列表、查看 bug 详情（生成描述、修改文件、
需人工资源及原因、失败原因、自动重试记录、操作日志）、对失败 bug **重试 / 跳过**。实时进度通过 SSE 推送（含 Agent 的
工具调用与文本流）。顶部 **⚙ 设置** 可在线编辑 pi / p4 / tapd 连接配置（url、key、模型、账号密码等），
保存写入 `overrides.yaml`（启动时合并、优先级最高），**无需手改 config.yaml**；workspaces 等复杂结构仍改 config.yaml。

### 自动重试（带失败证据）

`max_attempts` 控制单个 bug 的自动重试次数（默认 1 = 不自动重试）。处理失败时：

- 若 `attempts < max_attempts`：bug 回到队列自动重试，**不在 Tapd 发失败评论**；
- 每次失败都会把**压缩后的证据**（第几次、失败原因、当时打开的文件、Agent 的说明、需人工资源）存进
  状态库，重试时注入到新 Agent 的 prompt 里——新尝试从上次失败处继续排查，而不是重头开始；
- 重试/恢复前会**撤销上一次尝试遗留的 default changelist 打开文件**（专用 client workspace，只动 default，
  不动已生成的 pending changelist），保证每次尝试从干净工作区开始；
- 重试耗尽才标记 `failed`，并回写一次 Tapd 失败评论（含总尝试次数）。

管理台详情页会展示「自动重试记录」，方便人工判断为什么反复失败。

## P4 安全约定

- Agent 只允许 `p4 edit / p4 add / p4 delete`，**禁止 `p4 submit / p4 revert / p4 sync / p4 change`**（写入 prompt）
- 产出永远是 **pending changelist**，本工具**永不自动 submit**（`mode: auto` 目前同样只出 pending，需人工 review 后自行提交再回 Tapd 关单）
- `p4 reconcile -n` 兜底检测：若 Agent 改了文件却没 `p4 edit`，自动 `p4 reconcile` 打开，防止改动丢失

## 目录结构

```
src/
├── index.ts        # 命令行入口：serve / run / list / mcp-tools
├── worker.ts       # 编排工作线程（受控循环 + 分类 + 回写）
├── config.ts       # 配置加载（config.yaml + .env 覆盖）
├── models.ts       # Bug / AgentResult 数据模型
├── state.ts        # SQLite 状态库（control / jobs / events）
├── tapd.ts         # Tapd REST 客户端
├── tapdMcp.ts      # Tapd MCP 客户端
├── p4.ts           # p4 命令封装 + change-spec 处理
├── agent.ts        # pi 适配器（JSONL 事件流 + 取消/超时）
├── descgen.ts      # pending changelist 描述生成
├── verify.ts       # 验证门
└── web/
    ├── app.ts      # Express + SSE
    └── static/index.html
tests/core.test.ts  # vitest 单元/集成测试（fake pi / fake p4）
```

## 风险提示

自动修真实 Bug 有风险（测试覆盖不足、语义误判、误改）。推荐保持 `review` 模式：
代码修复 → 验证 → 生成 pending changelist → 人工 review/submit。自动提交仅适合测试覆盖率高的小步改动，
且需显式开启并保证测试覆盖。
