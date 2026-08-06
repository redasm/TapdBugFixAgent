"""配置加载：config.yaml + .env（环境变量优先）。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent

DEFAULT_PRIORITY_WEIGHT = {
    # Tapd 标准码
    "urgent": 0, "high": 0, "1": 0, "高": 0,
    "medium": 1, "2": 1, "中": 1,
    "low": 2, "3": 2, "低": 2,
    "4": 3,
}
DEFAULT_EXCLUDE_STATUS = ["resolved", "closed", "rejected"]
DEFAULT_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"]


@dataclass
class RepoConfig:
    name: str
    path: str
    test_cmd: str = ""
    agent: str = "claude"


@dataclass
class WorkspaceConfig:
    workspace_id: str
    owner: str
    repos: list[RepoConfig] = field(default_factory=list)
    default_repo: str = ""
    comment_status: str = "resolved"


@dataclass
class AgentSettings:
    """一个编码 Agent CLI 的运行参数。注意：这是"选哪个 CLI + 其参数"，不是裸模型。

    - model：可选，覆盖 CLI 使用的模型（对应 claude --model）；留空用 CLI 自身默认模型
    - 编码 Agent 的全部特性（自主编辑、工具调用、权限、上下文管理）由 CLI 本身提供
    """

    model: Optional[str] = ""
    allowed_tools: list[str] = field(default_factory=lambda: list(DEFAULT_ALLOWED_TOOLS))
    approval: str = "auto"
    permission_mode: str = "acceptEdits"  # claude --permission-mode
    template: str = ""  # 通用命令 Agent：含 {prompt} / {repo} 占位符的 shell 命令


@dataclass
class Config:
    mode: str = "review"
    poll_interval_min: int = 30
    max_bugs_per_run: int = 10
    max_attempts: int = 1
    agent_timeout_s: int = 900
    llm_review: bool = False
    exclude_status: list[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE_STATUS))
    priority_weight: dict = field(default_factory=lambda: dict(DEFAULT_PRIORITY_WEIGHT))
    workspaces: list[WorkspaceConfig] = field(default_factory=list)
    agents: dict[str, AgentSettings] = field(default_factory=dict)
    p4: dict = field(default_factory=dict)
    web: dict = field(default_factory=lambda: {"host": "127.0.0.1", "port": 8080, "token": ""})
    tapd: dict = field(default_factory=dict)
    config_path: str = ""

    # ---- 便捷访问 ----
    def priority_rank(self, bug: Any) -> int:
        """优先级 -> 排序权重，数字越小越优先；未知值排最后。"""
        w = self.priority_weight
        for key in (bug.priority, bug.priority_label, str(bug.priority)):
            if key in w:
                return w[key]
        return max(w.values()) + 1

    def web_token(self) -> str:
        return os.environ.get("WEB_TOKEN", "") or str(self.web.get("token") or "")

    def repo_by_name(self, name: str) -> Optional[RepoConfig]:
        for ws in self.workspaces:
            for repo in ws.repos:
                if repo.name == name:
                    return repo
        return None


def load_env_file(env_path: Optional[Path] = None) -> None:
    """极简 .env 解析（KEY=VALUE，'#' 注释，支持引号），写入 os.environ（已存在的优先）。"""
    env_path = Path(env_path) if env_path else Path(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            os.environ.setdefault(key, value)


def _build_repos(data: list) -> list[RepoConfig]:
    repos = []
    for item in data or []:
        if not isinstance(item, dict):
            continue
        repos.append(
            RepoConfig(
                name=str(item.get("name") or ""),
                path=str(item.get("path") or ""),
                test_cmd=str(item.get("test_cmd") or ""),
                agent=str(item.get("agent") or "claude"),
            )
        )
    return repos


def _build_agents(data: dict) -> dict[str, AgentSettings]:
    agents: dict[str, AgentSettings] = {}
    for name, item in (data or {}).items():
        if not isinstance(item, dict):
            continue
        agents[name] = AgentSettings(
            model=item.get("model") or None,  # 空字符串/未配置 -> None，CLI 用默认模型
            allowed_tools=list(item.get("allowed_tools") or DEFAULT_ALLOWED_TOOLS),
            approval=str(item.get("approval") or "auto"),
            permission_mode=str(item.get("permission_mode") or "acceptEdits"),
            template=str(item.get("template") or ""),
        )
    return agents


def load_config(path: Optional[str] = None, env_file: Optional[str] = None) -> Config:
    load_env_file(Path(env_file) if env_file else None)

    cfg = Config()

    cfg_path = Path(path) if path else Path("config.yaml")
    if cfg_path.exists():
        cfg.config_path = str(cfg_path)
        raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    else:
        raw = {}

    cfg.mode = str(raw.get("mode") or cfg.mode)
    cfg.poll_interval_min = int(raw.get("poll_interval_min") or cfg.poll_interval_min)
    cfg.max_bugs_per_run = int(raw.get("max_bugs_per_run") or cfg.max_bugs_per_run)
    cfg.max_attempts = int(raw.get("max_attempts") or cfg.max_attempts)
    cfg.agent_timeout_s = int(raw.get("agent_timeout_s") or cfg.agent_timeout_s)
    cfg.llm_review = bool(raw.get("llm_review") or cfg.llm_review)

    filters = raw.get("filters") or {}
    if filters.get("exclude_status"):
        cfg.exclude_status = [str(s) for s in filters["exclude_status"]]
    if raw.get("priority_weight"):
        cfg.priority_weight = {str(k): int(v) for k, v in raw["priority_weight"].items()}

    cfg.workspaces = []
    for ws in raw.get("workspaces") or []:
        if not isinstance(ws, dict):
            continue
        cfg.workspaces.append(
            WorkspaceConfig(
                workspace_id=str(ws.get("workspace_id") or ""),
                owner=str(ws.get("owner") or ""),
                repos=_build_repos(ws.get("repos")),
                default_repo=str(ws.get("default_repo") or ""),
                comment_status=str(ws.get("comment_status") or "resolved"),
            )
        )

    cfg.agents = _build_agents(raw.get("agents"))
    cfg.p4 = dict(raw.get("p4") or {})
    cfg.web = dict(raw.get("web") or {"host": "127.0.0.1", "port": 8080, "token": ""})
    cfg.tapd = dict(raw.get("tapd") or {})

    # ---- 环境变量覆盖（密钥优先放 .env）----
    cfg.tapd["backend"] = os.environ.get("TAPD_BACKEND", cfg.tapd.get("backend", "rest"))
    cfg.tapd["api_user"] = os.environ.get("TAPD_API_USER", cfg.tapd.get("api_user", ""))
    cfg.tapd["api_password"] = os.environ.get("TAPD_API_PASSWORD", cfg.tapd.get("api_password", ""))
    cfg.tapd["access_token"] = os.environ.get("TAPD_ACCESS_TOKEN", cfg.tapd.get("access_token", ""))
    # MCP 子配置（backend: mcp 时用）
    mcp = dict(cfg.tapd.get("mcp") or {})
    if not mcp.get("transport"):
        mcp["transport"] = os.environ.get("MCP_TRANSPORT", "streamable-http")
    if not mcp.get("url"):
        mcp["url"] = os.environ.get("MCP_URL", "")
    if not mcp.get("token"):
        mcp["token"] = os.environ.get("MCP_TOKEN", "")
    if not mcp.get("access_token"):
        mcp["access_token"] = cfg.tapd["access_token"]
    cfg.tapd["mcp"] = mcp

    cfg.p4["port"] = os.environ.get("P4PORT", cfg.p4.get("port", ""))
    cfg.p4["client"] = os.environ.get("P4CLIENT", cfg.p4.get("client", ""))
    cfg.p4["user"] = os.environ.get("P4USER", cfg.p4.get("user", ""))
    cfg.p4["password"] = os.environ.get("P4PASSWD", cfg.p4.get("password", ""))
    return cfg


def _is_placeholder(value: Any) -> bool:
    v = str(value or "").lower()
    if not v:
        return True
    return any(p in v for p in ("your", "example", "<", "todo", "xxx", "placeholder"))


def validate_config(cfg: Config) -> list[str]:
    """返回配置问题列表（空表示 OK）。"""
    problems = []
    backend = cfg.tapd.get("backend", "rest")
    if backend == "mcp":
        mcp = cfg.tapd.get("mcp") or {}
        if mcp.get("transport") == "streamable-http" and not mcp.get("url"):
            problems.append("缺少 Tapd MCP 连接地址（tapd.mcp.url，腾讯云托管 MCP 专属地址）")
        if not (mcp.get("access_token") or cfg.tapd.get("access_token")):
            problems.append("缺少 TAPD_ACCESS_TOKEN（个人访问令牌，推荐）或 TAPD_API_USER/PASSWORD")
    elif not cfg.tapd.get("api_user") or not cfg.tapd.get("api_password"):
        problems.append("缺少 Tapd API 凭据（TAPD_API_USER / TAPD_API_PASSWORD 或 config.tapd）")

    # p4 占位符检测（模板里的示例值会导致运行时才报错，这里提前提示）
    for key in ("port", "client", "user"):
        if _is_placeholder(cfg.p4.get(key)):
            problems.append(f"p4.{key} 未配置（当前: {cfg.p4.get(key)!r}），Agent 无法连接 Perforce")
    if not cfg.workspaces:
        problems.append("未配置 workspaces")
    for ws in cfg.workspaces:
        if not ws.workspace_id:
            problems.append("workspace.workspace_id 为空")
        if not ws.owner:
            problems.append(f"workspace {ws.workspace_id} 未配置 owner（current_owner 过滤用）")
        for repo in ws.repos:
            if not repo.path or not Path(repo.path).is_dir():
                problems.append(f"仓库 {repo.name!r} 路径不存在: {repo.path}")
    if not cfg.p4.get("client"):
        problems.append("未配置 P4CLIENT（Agent 专用 p4 workspace）")
    return problems
