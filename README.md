# TapdBugFixAgent

自动从 Tapd 拉取分配给你的 Bug，按优先级一个一个交给 Claude CLI / Codex CLI 等编码 Agent 修复；
修复结果生成 **Perforce pending changelist**（描述由 Tapd bug 单信息自动生成），
并通过一个 **Web 管理台** 提供开启 / 关闭 / 暂停 / 恢复、查看已修改列表、描述、无法修改原因等能力。

涉及 **prefab / 表格等二进制资源**的修改不会强行改、不会卡住：Agent 会把它们列入「需人工处理资源」，
记录在 pending changelist 描述和管理台里，人工在编辑器里处理即可。

## 架构

```
Tapd ──MCP(个人访问令牌)──> Orchestrator(worker) ──subprocess──> Claude CLI / Codex CLI / 任意Agent
 Tapd ──REST(API账号)───>   │  │                            │
      ^                    │  └─ p4 edit/add ────────────▶ Perforce workspace
      └──── 评论/状态回写    │
                            │
                  Web 管理台 (FastAPI + SSE)  ←—— 启停/暂停/恢复/查看
```

Tapd 接入支持两种后端（`config.yaml tapd.backend`）：
- **`mcp`（推荐）**：通过 Tapd MCP Server 接入，用**个人访问令牌** `TAPD_ACCESS_TOKEN`（个人设置里即可创建，无需公司 API 账号权限、**无需托管**）。两种传输：
  - `stdio`（默认推荐）：本地 `npx -y @xihe-lab/tapd-mcp-server`（用 Node 跑官方包，无需 Python 3.13；装好 `uvx mcp-server-tapd` 也可）
  - `streamable-http`（可选）：填腾讯云托管 MCP 的专属连接地址 `tapd.mcp.url`
  - 已内置官方真实工具名映射（`tapd_get_bugs` / `tapd_update_bug` / `tapd_create_comment`），开箱即用；`python -m tapd_agent mcp-tools` 可随时核对
- **`rest`**：直接调 Tapd OpenAPI（`api_user`/`api_password`，需 API 账号权限）

- `worker.py`：受控工作线程，按控制态（stopped / running / paused）消费 bug 队列
- `tapd/client.py`：REST 后端；`tapd/mcp_client.py`：MCP 后端（接口对齐，可插拔）
- `p4util.py`：p4 命令封装（sync / opened / diff / reconcile / change-spec / 创建 pending changelist）
- `agents/`：编码 Agent 适配层（Claude CLI、Codex CLI、通用命令模板），统一结构化输出；**配置选的是编码 Agent 的 CLI，不是裸模型**（`model` 仅是可选覆盖，不填用 CLI 默认模型）
- `descgen.py`：pending changelist 描述生成（含「需人工处理资源」段）
- `verify.py`：验证门（opened 检查 / reconcile 兜底 / 测试命令）
- `web/`：FastAPI 管理台 + 单页前端（SSE 实时刷新）

## 状态机

```
pending → in_progress
        → resolved     # 代码改完 + 验证过 + pending changelist 已生成
        → partial      # 代码改完 + 部分资源需人工（描述已记录）
        → manual_only  # 纯资源修改（只记录 + Tapd 评论，不建 changelist）
        → failed       # 失败，记录原因，不自动重试
        → skipped      # 人工跳过
```

## 安装与配置

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt

cp config.example.yaml config.yaml   # 填写 workspace_id / owner / 仓库映射 / p4
cp .env.example .env                 # 填 TAPD_API_USER / TAPD_API_PASSWORD / P4*
```

### 前置条件

1. **Tapd 凭据（二选一）**：
   - 推荐：**个人访问令牌** `TAPD_ACCESS_TOKEN`（Tapd 个人设置 → 个人访问令牌 创建），配 MCP 后端（本地 stdio，无需托管）
   - 或：**API 账号** `api_user` / `api_password`（个人设置 → API账号 创建），配 REST 后端
2. **workspace_id**：以 API/MCP 返回为准（或从 bug 单链接 `bug_<workspace_id>...` 前缀确认）
3. **P4 client**：为 Agent 建一个**专用 client workspace**（如 `tapd-agent_<你>`），`p4` 命令需在 PATH 中
4. **仓库映射**：`config.yaml` 的 `workspaces[].repos[]` 指向本地 p4 workspace root

## 使用

```bash
# 只读检查：列出"分配给我的"待处理 bug（按优先级排序），不修改任何东西
python -m tapd_agent dry-run

# 调试：连上 Tapd MCP 并打印发现的工具清单（确认工具名，必要时填 config 的 tool_map）
python -m tapd_agent mcp-tools

# 无界面单步：处理最高优先级的一个 bug（测试用）
python -m tapd_agent run --once

# 启动 Web 管理台 + 工作线程
python -m tapd_agent serve
# 打开 http://127.0.0.1:8080 ，点「开启」开始自动处理
```

管理台操作：**开启 / 暂停 / 恢复 / 关闭**、按状态筛选列表、查看 bug 详情（生成描述、修改文件、
需人工资源及原因、失败原因、操作日志）、对失败 bug **重试 / 跳过**。

## P4 安全约定

- Agent 只允许 `p4 edit / p4 add / p4 delete`，**禁止 `p4 submit / p4 revert / p4 sync / p4 change`**（写入 prompt）
- 产出永远是 **pending changelist**，`review` 模式**永不自动 submit**，人工 review 后自行提交再回 Tapd 关单
- `auto` 模式（`mode: auto`）才会自动 `p4 submit`，需显式开启并保证测试覆盖
- `p4 reconcile -n` 兜底检测：若 Agent 改了文件却没 `p4 edit`，自动 `p4 reconcile` 打开，防止改动丢失

## 目录结构

```
tapd_agent/
├── cli.py            # serve / run / dry-run 入口
├── worker.py         # 编排工作线程（受控循环 + 分类 + 回写）
├── config.py         # 配置加载（config.yaml + .env 覆盖）
├── models.py         # Bug / AgentResult 数据模型
├── state.py          # SQLite 状态库（control / jobs / events）
├── tapd/client.py    # Tapd REST 客户端
├── p4util.py         # p4 命令封装 + change-spec 处理
├── agents/           # base / claude_cli / codex_cli / command
├── descgen.py        # pending changelist 描述生成
├── verify.py         # 验证门
└── web/
    ├── app.py        # FastAPI + SSE
    └── static/index.html
```

## 风险提示

自动修真实 Bug 有风险（测试覆盖不足、语义误判、误改）。推荐保持 `review` 模式：
代码修复 → 验证 → 生成 pending changelist → 人工 review/submit。自动 resolve/提交仅适合测试覆盖率高的小步改动。
