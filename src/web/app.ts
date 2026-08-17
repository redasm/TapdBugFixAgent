/** Express 管理台：状态/控制/bug 列表与详情/SSE 实时进度。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  applySettingsOverrides,
  saveSettingsOverrides,
  webToken,
  type Config,
  type PiProviderConfig,
  type SettingsOverrides,
} from "../config.js";
import { effectivePiModel } from "../agent.js";
import type { StateStore } from "../state.js";
import type { Worker } from "../worker.js";

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "static");
/** 构建版本（package.json version）：/api/status 带上，页面一眼可辨是否旧进程在跑
 *  （src 与 dist 布局一致，../../ 都指向项目根）。 */
const PKG_VERSION = (() => {
  try {
    const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    return String(JSON.parse(fs.readFileSync(p, "utf-8")).version ?? "");
  } catch {
    return "";
  }
})();
const _VALID_ACTIONS = new Set(["start", "stop", "pause", "resume"]);

/** GET /api/settings 的脱敏视图：密钥只回传"是否已设置"，绝不回传明文。 */
function settingsForWeb(config: Config): Record<string, unknown> {
  const p = config.pi.provider;
  const tapd = config.tapd as Record<string, unknown>;
  return {
    pi: {
      effective_model: effectivePiModel(config.pi),
      provider: p
        ? {
            id: p.id ?? "",
            base_url: p.base_url ?? "",
            api_key_env: p.api_key_env ?? "",
            auth_header: p.auth_header ?? true,
            model_id: p.model_id ?? "",
            reasoning: p.reasoning ?? true,
            context_window: p.context_window ?? 200000,
            max_tokens: p.max_tokens ?? 32000,
            has_api_key: !!(p.api_key || p.api_key_env),
          }
        : null,
    },
    p4: {
      port: config.p4.port ?? "",
      client: config.p4.client ?? "",
      user: config.p4.user ?? "",
      password_set: !!config.p4.password,
    },
    tapd: {
      backend: String(tapd.backend ?? ""),
      access_token_set: !!tapd.access_token,
      api_user: String(tapd.api_user ?? ""),
      api_password_set: !!tapd.api_password,
    },
  };
}

/** 把请求 body 转成 SettingsOverrides；字符串空值/缺失 = 保持不变（不覆盖）。 */
function settingsFromBody(body: Record<string, unknown>): SettingsOverrides {
  const ov: SettingsOverrides = {};
  const prov = (body.pi ?? {}) as Record<string, unknown>;
  const provRaw = (prov.provider ?? {}) as Record<string, unknown>;
  if (Object.keys(provRaw).length) {
    const pv: Partial<PiProviderConfig> = {};
    for (const k of ["id", "base_url", "api_key_env", "api_key", "model_id"] as const) {
      const v = provRaw[k];
      if (typeof v === "string" && v !== "") pv[k] = v;
    }
    for (const k of ["auth_header", "reasoning"] as const) {
      if (typeof provRaw[k] === "boolean") pv[k] = provRaw[k];
    }
    for (const k of ["context_window", "max_tokens"] as const) {
      const v = provRaw[k];
      if (v !== undefined && v !== null && v !== "") pv[k] = Number(v);
    }
    ov.pi = { provider: pv };
  }
  const p4Raw = (body.p4 ?? {}) as Record<string, unknown>;
  const p4: Record<string, string> = {};
  for (const k of ["port", "client", "user", "password"] as const) {
    const v = p4Raw[k];
    if (typeof v === "string" && v !== "") p4[k] = v;
  }
  if (Object.keys(p4).length) ov.p4 = p4;
  const tapdRaw = (body.tapd ?? {}) as Record<string, unknown>;
  const tapd: NonNullable<SettingsOverrides["tapd"]> = {};
  for (const k of ["backend", "access_token", "api_user", "api_password"] as const) {
    const v = tapdRaw[k];
    if (typeof v === "string" && v !== "") tapd[k] = v;
  }
  if (Object.keys(tapd).length) ov.tapd = tapd;
  return ov;
}

export function createApp(config: Config, store: StateStore, worker: Worker): express.Express {
  const app = express();

  app.use(express.json());

  function auth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    const token = webToken(config); // 每次现算，设置页改了 web.token 也立即生效
    if (!token) return next();
    let t = String(req.query.token ?? "");
    const authz = req.headers.authorization ?? "";
    if (authz.startsWith("Bearer ")) t = authz.slice(7);
    if (t !== token) {
      res.status(401).json({ detail: "未授权" });
      return;
    }
    next();
  }

  app.get("/", (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  app.get("/api/status", auth, (_req, res) => {
    res.json({ ...worker.status(), version: PKG_VERSION });
  });

  app.post("/api/control", auth, (req, res) => {
    const a = String((req.body as Record<string, unknown> | undefined)?.action ?? "");
    if (!_VALID_ACTIONS.has(a)) {
      res.status(400).json({ detail: `未知 action: ${a}` });
      return;
    }
    const control = worker[a as "start" | "stop" | "pause" | "resume"]();
    res.json({ control });
  });

  app.get("/api/settings", auth, (_req, res) => {
    res.json(settingsForWeb(config));
  });

  app.post("/api/settings", auth, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ov = settingsFromBody(body);
    applySettingsOverrides(config, ov);
    try {
      saveSettingsOverrides(ov);
    } catch (exc) {
      res.status(500).json({ detail: `保存 overrides.yaml 失败: ${(exc as Error).message}` });
      return;
    }
    worker.resetTapdClients(); // tapd 凭据/backend 变更立即生效
    res.json(settingsForWeb(config));
  });

  app.get("/api/bugs", auth, async (_req, res) => {
    res.json({ items: await worker.listBugsForWeb() });
  });

  app.get("/api/bugs/:id", auth, async (req, res) => {
    const detail = await worker.bugDetailForWeb(String(req.params.id));
    if (!detail) {
      res.status(404).json({ detail: "未找到该 bug" });
      return;
    }
    res.json(detail);
  });

  app.post("/api/bugs/:id/retry", auth, async (req, res) => {
    if (!(await worker.retryBug(String(req.params.id)))) {
      res.status(404).json({ detail: "未找到该 bug" });
      return;
    }
    res.json({ ok: true });
  });

  // 重试全部失败任务：重置为待处理并入队（开启状态下按优先级重新处理）
  app.post("/api/retry-failed", auth, (_req, res) => {
    const retried = worker.retryAllFailed();
    res.json({ ok: true, retried });
  });

  // 清空全部本地记录并从 Tapd 强制重新同步（会中断当前处理中的 bug）
  app.post("/api/resync", auth, async (_req, res) => {
    try {
      const r = await worker.resyncFromTapd();
      res.json({ ok: true, ...r });
    } catch (exc) {
      res.status(500).json({ detail: `重新同步失败: ${(exc as Error).message}` });
    }
  });

  app.post("/api/bugs/:id/skip", auth, async (req, res) => {
    if (!(await worker.skipBug(String(req.params.id)))) {
      res.status(404).json({ detail: "未找到该 bug" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/events", auth, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const timer = setInterval(() => {
      void (async () => {
        const payload: Record<string, unknown> = {
          status: worker.status(),
          items: await worker.listBugsForWeb(),
        };
        // 底部 Agent 输出区：附加当前处理中 bug 的实时详情（含 debug 级进度事件），
        // 前端无需每 2s 另发 /api/bugs/:id 请求；无当前 bug 时不附加（前端显示等待中）。
        const cur = worker.currentBugId;
        if (cur) {
          try {
            payload.current_detail = await worker.bugDetailForWeb(cur);
          } catch {
            // 取详情失败不阻断 snapshot 推送
          }
        }
        res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
      })();
    }, 2000);
    req.on("close", () => clearInterval(timer));
  });

  return app;
}
