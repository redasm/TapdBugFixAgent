import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../src/config.js";
import { effectivePiModel, ensurePiModels } from "../src/agent.js";
import { piProviderModelIds, piProviderModelsProblem } from "../src/agentRoles.js";
import { reviewerModel } from "../src/review.js";
import { createApp } from "../src/web/app.js";
import type { StateStore } from "../src/state.js";
import type { Worker } from "../src/worker.js";

const dirs: string[] = [];
let server: Server | undefined;
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tapd-pi-config-"));
  dirs.push(dir);
  return dir;
};
const load = (dir: string) => configModule.loadConfig(
  path.join(dir, "config.yaml"), path.join(dir, ".env"), path.join(dir, "overrides.yaml"),
);
/** /api/settings 的脱敏视图：按固定字段结构访问。 */
const jsonOf = async (response: Response): Promise<Record<string, any>> =>
  await response.json() as Record<string, any>;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Pi 配置升级", () => {
  it("只填地址、API Key 和模型即可注册并使用默认网关；Reviewer 默认沿用同一模型", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    base_url: https://gateway.example.com
    api_key: test-key
    model_id: fix-model
`);
    const config = load(dir);
    const modelFile = path.join(dir, "models.json");
    ensurePiModels(config.pi, modelFile);
    expect(effectivePiModel(config.pi)).toBe("gateway/fix-model");
    // 没有 agents.roles.review.model 时，Reviewer 直接用 pi.provider 默认模型
    expect(reviewerModel(config)).toBe("gateway/fix-model");
    expect(JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway).toMatchObject({
      baseUrl: "https://gateway.example.com",
      apiKey: "test-key",
      api: "anthropic-messages",
      authHeader: true,
      models: [{ id: "fix-model" }],
    });
  });

  it("高级配置仍可显式选择 x-api-key 认证", () => {
    const file = path.join(tempDir(), "models.json");
    ensurePiModels({ provider: {
      base_url: "https://gateway.example.com", api_key: "test-key", model_id: "model", auth_header: false,
    } }, file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).providers.gateway).not.toHaveProperty("authHeader");
  });

  it("缺 model_id 时仍按 base_url/api_key 注册 provider，模型由 agents.roles 提供（model_id 仅可选回退）", () => {
    const dir = tempDir();
    // 只填地址与鉴权，模型全部写在角色里；model_id 完全不配。
    fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    base_url: https://gateway.example.com
    api_key: test-key
agents:
  roles:
    investigation: { model: inv-model }
    review: { model: review-model }
`);
    const config = load(dir);
    const modelFile = path.join(dir, "models.json");
    ensurePiModels(config.pi, modelFile, config);

    // provider 仍然注册（改造前这里会直接 return，根本不写 models.json）
    const gateway = JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway;
    expect(gateway).toMatchObject({ baseUrl: "https://gateway.example.com", apiKey: "test-key" });
    expect(gateway.models.map((model: { id: string }) => model.id).sort())
      .toEqual(["inv-model", "review-model"]);
    // 没有 model_id → 不传 --model（各角色用自己的角色模型），且 provider 无默认模型项
    expect(effectivePiModel(config.pi)).toBe("");
    // 注册出来的模型集合与启动告警口径同源
    expect(piProviderModelIds(config).sort()).toEqual(["inv-model", "review-model"]);
    expect(piProviderModelsProblem(config)).toBeNull();
    expect(configModule.validateConfig(config).some((problem: string) => problem.includes("没有可用模型"))).toBe(false);
  });

  it("动态收集的角色模型只收本 provider：跨 provider 不误注册；model_id 仍是可选的首个回退项", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
    model_id: fix-model
agents:
  roles:
    implementation: { model: impl-model }                 # 裸名 → 归属 gateway
    review: { model: "gateway/review-model" }             # 显式 gateway → 收录
    recovery: { model: "other-provider/other-model" }     # 别的 provider → 不收录
    coordinator: { model: " gateway/coord-model " }       # 前后空白也要归一
`);
    const config = load(dir);
    const modelFile = path.join(dir, "models.json");
    ensurePiModels(config.pi, modelFile, config);

    const gateway = JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway;
    // 顺序稳定：model_id（可选回退）在前，其后是角色模型；other-provider 的模型绝不出现
    expect(gateway.models.map((model: { id: string }) => model.id))
      .toEqual(["fix-model", "impl-model", "review-model", "coord-model"]);
    expect(JSON.stringify(gateway)).not.toContain("other-model");
    expect(piProviderModelIds(config))
      .toEqual(["fix-model", "impl-model", "review-model", "coord-model"]);
  });

  it("provider 注册不出任何模型时只告警不阻断；补齐 model_id 或角色模型即消失", () => {
    const dir = tempDir();
    const write = (providerExtra: string, roleModel = ""): void => {
      fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    id: gateway
    base_url: https://gateway.example.com
    api_key: test-key
${providerExtra}
agents:
  roles:
    review: { model: ${roleModel || '""'} }
`);
    };
    write("");
    const empty = load(dir);
    // 事实：provider 仍然注册，只是没有模型；告警必须能解释这个缺口
    const modelFile = path.join(dir, "models.json");
    ensurePiModels(empty.pi, modelFile, empty);
    expect(JSON.parse(fs.readFileSync(modelFile, "utf8")).providers.gateway.models).toEqual([]);
    const problem = piProviderModelsProblem(empty);
    expect(problem).toContain("agents.roles.<role>.model");
    expect(configModule.validateConfig(empty)).toContain(problem);

    // 只补角色模型（仍然没有 model_id）→ 告警消失，provider 有了可用模型
    write("", "review-model");
    const roleOnly = load(dir);
    expect(piProviderModelsProblem(roleOnly)).toBeNull();
    expect(piProviderModelIds(roleOnly)).toEqual(["review-model"]);

    // 只补 model_id → 告警同样消失
    write("    model_id: fix-model");
    const idOnly = load(dir);
    expect(piProviderModelsProblem(idOnly)).toBeNull();
    expect(piProviderModelIds(idOnly)).toEqual(["fix-model"]);
  });

  it("旧配置与覆盖文件无法切回已移除的后端，review.model 也不再生效只提示迁移", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
agent: { backend: codex }
codex: { model: old-model, reasoning_effort: invalid }
pi:
  provider: { id: gateway, model_id: fix-model }
review: { backend: codex, model: legacy-config-model }
`);
    fs.writeFileSync(path.join(dir, "overrides.yaml"), `
agent: { backend: codex }
codex: { model: obsolete-model }
pi:
  provider: { model_id: current-model }
review: { backend: codex, model: legacy-overrides-model }
`);
    const config = load(dir);
    expect(config).not.toHaveProperty("agent");
    expect(config).not.toHaveProperty("codex");
    expect(config.review).not.toHaveProperty("backend");
    // review 段只剩这两个字段：旧 model 既不在 Config 里，也不参与任何解析
    expect(Object.keys(config.review).sort()).toEqual(["enabled", "max_fix_rounds"]);
    expect(effectivePiModel(config.pi)).toBe("gateway/current-model");
    expect(reviewerModel(config)).toBe("gateway/current-model");
    // 迁移提示指向唯一入口；提示里出现的只是迁移说明文字，不是可生效字段
    expect(configModule.validateConfig(config).join("\n")).toContain("agents.roles.review.model");
  });

  it("保存清除旧后端与旧 review.model 设置，并保留 Pi、评审开关和连接配置", () => {
    const dir = tempDir();
    const settingsPath = path.join(dir, "overrides.yaml");
    fs.writeFileSync(settingsPath, `
agent: { backend: codex }
codex: { model: old-model }
pi:
  provider: { id: gateway, model_id: fix-model }
review: { backend: codex, enabled: false, model: legacy-review-model }
p4: { client: existing-client }
tapd: { backend: mcp }
`);
    configModule.saveSettingsOverrides({ pi: { provider: { model_id: "new-model" } } }, settingsPath);
    expect(configModule.readSettingsOverrides(settingsPath)).toEqual({
      pi: { provider: { id: "gateway", model_id: "new-model" } },
      review: { enabled: false },
      p4: { client: "existing-client" },
      tapd: { backend: "mcp" },
    });
    expect(effectivePiModel(load(dir).pi)).toBe("gateway/new-model");
  });

  it("Reviewer 模型唯一入口是 agents.roles.review.model：空值沿用 pi.provider，可只写裸模型名", () => {
    const dir = tempDir();
    const config = load(dir);
    // 无 provider、无角色模型 → pi 自身默认模型（空字符串 = 不传 --model）
    expect(reviewerModel(config)).toBe("");
    config.pi.provider = { id: "gateway", model_id: "fix-model" };
    expect(reviewerModel(config)).toBe("gateway/fix-model");
    config.agents = { roles: { review: { model: "review-model" } }, problems: [] };
    expect(reviewerModel(config)).toBe("gateway/review-model");
    config.agents = { roles: { review: { model: "other/model" } }, problems: [] };
    expect(reviewerModel(config)).toBe("other/model");
  });

  it("设置接口不再读写 review.model，正常保存 Pi 与评审开关且不暴露密钥", async () => {
    const dir = tempDir();
    const config = load(dir);
    vi.stubEnv("WEB_TOKEN", "");
    const save = configModule.saveSettingsOverrides;
    vi.spyOn(configModule, "saveSettingsOverrides").mockImplementation((overrides) =>
      save(overrides, path.join(dir, "overrides.yaml")));
    const worker = { resetTapdClients: vi.fn() };
    const app = createApp(config, {} as StateStore, worker as unknown as Worker);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not listen");
    const url = `http://127.0.0.1:${address.port}/api/settings`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: { backend: "codex" },
        codex: { model: "old-model" },
        pi: { provider: { base_url: "https://gateway.example.com", model_id: "fix-model", api_key: "test-secret" } },
        review: { backend: "codex", model: "review-model", enabled: false },
      }),
    });
    expect(response.status).toBe(200);
    const posted = await jsonOf(response);
    const fetched = await jsonOf(await fetch(url));
    expect(fetched).toEqual(posted);
    expect(fetched).not.toHaveProperty("agent");
    expect(fetched).not.toHaveProperty("codex");
    expect(fetched.review).not.toHaveProperty("backend");
    expect(fetched.review).not.toHaveProperty("model");
    expect(fetched.pi.effective_model).toBe("gateway/fix-model");
    expect(fetched.pi.provider.has_api_key).toBe(true);
    expect(JSON.stringify(fetched)).not.toContain("test-secret");
    // POST 里的 review.model 被忽略：Reviewer 仍用 pi.provider 默认模型
    expect(reviewerModel(config)).toBe("gateway/fix-model");
    const reloaded = load(dir);
    expect(effectivePiModel(reloaded.pi)).toBe("gateway/fix-model");
    expect(reviewerModel(reloaded)).toBe("gateway/fix-model");
    expect(reloaded.review.enabled).toBe(false);
    expect(reloaded.review).not.toHaveProperty("backend");
    expect(reloaded.review).not.toHaveProperty("model");
    const savedOverrides = configModule.readSettingsOverrides(path.join(dir, "overrides.yaml"));
    expect(Object.keys(savedOverrides?.review ?? {})).toEqual(["enabled"]);
    config.pi.provider!.api_key = undefined;
    vi.stubEnv("PI_API_KEY", "env-secret");
    const envSettings = await jsonOf(await fetch(url));
    expect(envSettings.pi.provider.has_api_key).toBe(true);
    expect(JSON.stringify(envSettings)).not.toContain("env-secret");
  });
});
