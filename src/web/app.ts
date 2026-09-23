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
import { effectivePiModel, effectivePiProviderId } from "../agent.js";
import { agentRoleModelSummary } from "../agentRoles.js";
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
  /** 默认回退模型口径：没配 agents.roles.<role>.model 的角色会回落到它。
   *  字段名 effective_model 保留（前端/脚本已依赖），但它的含义只是「默认回退」，
   *  不是「任务实际用的模型」——实际调用过的 role/model 只在任务详情的 actual_models 里。 */
  const defaultModel = effectivePiModel(config.pi);
  return {
    review: {
      enabled: config.review.enabled,
      max_fix_rounds: config.review.max_fix_rounds,
    },
    pi: {
      effective_model: defaultModel,
      default_model: defaultModel,
      // 角色模型配置摘要（后端已解析成最终生效值，未配置的角色也列出）：不含任何密钥。
      agent_roles: agentRoleModelSummary(config, defaultModel),
      provider: p
        ? {
            id: effectivePiProviderId(config.pi),
            base_url: p.base_url ?? "",
            api_key_env: p.api_key_env ?? "",
            auth_header: p.auth_header ?? true,
            model_id: p.model_id ?? "",
            reasoning: p.reasoning ?? true,
            context_window: p.context_window ?? 200000,
            max_tokens: p.max_tokens ?? 32000,
            has_api_key: !!(p.api_key || process.env[p.api_key_env || "PI_API_KEY"]),
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
  const reviewRaw = (body.review ?? {}) as Record<string, unknown>;
  const review: NonNullable<SettingsOverrides["review"]> = {};
  if (typeof reviewRaw.enabled === "boolean") review.enabled = reviewRaw.enabled;
  if (reviewRaw.max_fix_rounds !== undefined && reviewRaw.max_fix_rounds !== "") {
    review.max_fix_rounds = Math.max(0, Number(reviewRaw.max_fix_rounds));
  }
  if (Object.keys(review).length) ov.review = review;
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
  app.get("/favicon.ico", (_req, res) => res.status(204).end());

  app.get("/api/status", auth, (_req, res) => {
    res.json({ ...worker.status(), version: PKG_VERSION, quality: store.qualityMetrics() });
  });

  app.get("/api/quality/metrics", auth, (_req, res) => {
    res.json(store.qualityMetrics());
  });

  app.get("/api/quality/candidates", auth, (req, res) => {
    const days = req.query.followup_days === undefined ? 14 : Number(req.query.followup_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      res.status(400).json({ detail: "随访窗口必须为 1–365 天" });
      return;
    }
    res.json(store.audit.metrics({ cohort: String(req.query.cohort || "") || undefined, followup_days: days }));
  });

  app.get("/api/bugs/:id/attempts", auth, (req, res) => {
    const id = String(req.params.id);
    res.json({ attempts: store.audit.attempts(id), candidates: store.audit.candidates(id), feedback: store.audit.feedback(id) });
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

  // 清空任务状态与事件并从 Tapd 强制重新同步；长期人工质量反馈保留。
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

  app.post("/api/bugs/:id/feedback", auth, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      store.recordFeedback(String(req.params.id), {
        outcome: String(body.outcome ?? "") as never,
        reason: String(body.reason ?? ""),
        human_changed_lines: body.human_changed_lines == null || body.human_changed_lines === "" ? null : Number(body.human_changed_lines),
        candidate_id: typeof body.candidate_id === "string" ? body.candidate_id : "",
        human_minutes: body.human_minutes == null || body.human_minutes === "" ? null : Number(body.human_minutes),
        modification_category: String(body.modification_category || ""),
        final_patch_ref: String(body.final_patch_ref || ""),
        submitted_changelist: body.submitted_changelist === null
          || body.submitted_changelist === undefined
          || body.submitted_changelist === ""
          ? null
          : Number(body.submitted_changelist),
      });
    } catch (exc) {
      const message = (exc as Error).message;
      res.status(message.startsWith("未找到") ? 404 : 400).json({ detail: message });
      return;
    }
    res.json({ ok: true, metrics: store.qualityMetrics() });
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
          status: { ...worker.status(), quality: store.qualityMetrics() },
          items: await worker.listBugsForWeb(),
        };
        // 快照只推状态与列表（status 里已含 current_stage：当前阶段 + 该阶段模型）。
        // 原先还附加「当前处理中 bug 的实时详情」供底部日志面板渲染，日志面板移除后
        // 前端不再消费该字段，这里一并去掉，避免每 2s 白跑一次详情查询与事件序列化。
        res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
      })();
    }, 2000);
    req.on("close", () => clearInterval(timer));
  });

  return app;
}
