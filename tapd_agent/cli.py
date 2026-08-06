"""命令行入口。

  python -m tapd_agent dry-run      # 只读：列出待处理 bug（按优先级）
  python -m tapd_agent run --once   # 无界面：处理最高优先级 1 个 bug
  python -m tapd_agent run          # 无界面：处理一批
  python -m tapd_agent serve        # 启动 Web 管理台 + 工作线程
"""
from __future__ import annotations

import argparse
import sys
from typing import Optional

from .config import load_config, validate_config
from .state import StateStore
from .worker import Worker


def _make(config_path: str, db_path: str):
    config = load_config(config_path)
    for problem in validate_config(config):
        print(f"[配置警告] {problem}")
    store = StateStore(db_path)
    worker = Worker(config, store)
    return config, store, worker


def cmd_dry_run(args) -> int:
    config, store, worker = _make(args.config, args.db)

    rows = []
    for ws in config.workspaces:
        client = worker._tapd(ws)  # 按 backend（rest / mcp）取客户端
        try:
            fetched = client.list_bugs(current_owner=ws.owner)
        except Exception as exc:
            print(f"[error] workspace {ws.workspace_id} 拉取失败: {exc}")
            continue
        for b in fetched:
            job = store.get_job(b.id)
            rows.append((b, job["agent_state"] if job else None))

    rows.sort(key=lambda r: (config.priority_rank(r[0]), r[0].created or ""))
    print(f"{'Bug ID':>20}  {'优先级':<4} {'状态':<10} {'Agent':<8} 标题")
    print("-" * 90)
    for b, job_state in rows:
        label = b.priority_label or b.priority or "-"
        st = job_state or "未处理"
        print(f"{b.id:>20}  {label:<4} {b.status:<10} {st:<8} {b.title[:48]}")
    print(f"\n共 {len(rows)} 个分配给我的 bug（含已处理的，见 Agent 列）")
    return 0


def cmd_run(args) -> int:
    config, store, worker = _make(args.config, args.db)
    limit = 1 if args.once else config.max_bugs_per_run
    count = worker.run_batch(limit)
    print(f"处理完成 {count} 个 bug")
    for it in store.list_jobs("all")[:limit]:
        mark = "✓" if it["agent_state"] in ("resolved", "partial") else "✗"
        print(f"  {mark} {it['bug_id']}  [{it['agent_state']}]  changelist={it['changelist']}  {it['title'][:40]}")
    return 0


def cmd_serve(args) -> int:
    config, store, worker = _make(args.config, args.db)
    worker.start_loop()

    import uvicorn

    from .web.app import create_app

    app = create_app(config, store, worker)
    host = args.host or config.web.get("host") or "127.0.0.1"
    port = args.port or int(config.web.get("port") or 8080)
    token = config.web_token()
    print(f"管理台: http://{host}:{port}")
    if token:
        print(f"token: {token}（URL 加 ?token= 或页面顶部填入）")
    else:
        print("提示: 未配置 WEB_TOKEN，管理台无鉴权（仅建议本机使用）")
    print("默认处于「关闭」状态，请在管理台点击「开启」开始自动处理。Ctrl+C 退出。")
    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    finally:
        worker.shutdown()
    return 0


def cmd_mcp_tools(args) -> int:
    """连上 Tapd MCP，打印发现的工具清单（用于确认 tool_map）。"""
    config, store, worker = _make(args.config, args.db)
    from .tapd import TapdMcpClient

    backend = config.tapd.get("backend", "rest")
    if backend != "mcp":
        print("[error] 当前 backend 不是 mcp（config.yaml tapd.backend: mcp）")
        return 1
    mcp_cfg = config.tapd.get("mcp") or {}
    ws_id = config.workspaces[0].workspace_id if config.workspaces else ""
    client = TapdMcpClient(ws_id, mcp_cfg)
    try:
        client.connect()
    except Exception as exc:
        print(f"[error] 连接失败: {exc}")
        return 1
    print(client.dump_tools())
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="tapd_agent", description="Tapd Bug 自动修复 Agent（p4 pending changelist 产出）")
    parser.add_argument("--config", default="config.yaml", help="配置文件路径（默认 config.yaml）")
    parser.add_argument("--db", default="tapd_agent.db", help="状态库路径（默认 tapd_agent.db）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("dry-run", help="只读：列出分配给我的待处理 bug（按优先级）")
    sub.add_parser("mcp-tools", help="调试：连上 Tapd MCP 并打印发现的工具清单")

    p_run = sub.add_parser("run", help="无界面处理一批 bug")
    p_run.add_argument("--once", action="store_true", help="只处理最高优先级 1 个")

    p_serve = sub.add_parser("serve", help="启动 Web 管理台 + 工作线程")
    p_serve.add_argument("--host", default=None, help="监听地址（默认取配置）")
    p_serve.add_argument("--port", type=int, default=None, help="端口（默认取配置）")

    args = parser.parse_args(argv)
    if args.cmd == "dry-run":
        return cmd_dry_run(args)
    if args.cmd == "mcp-tools":
        return cmd_mcp_tools(args)
    if args.cmd == "run":
        return cmd_run(args)
    if args.cmd == "serve":
        return cmd_serve(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
