import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as configModule from "../src/config.js";
import { effectivePiModel, ensurePiModels } from "../src/agent.js";
import { effectiveReviewModel } from "../src/review.js";
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
  it("只填地址、API Key 和模型即可注册并使用默认网关", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
pi:
  provider:
    base_url: https://gateway.example.com
    api_key: test-key
    model_id: fix-model
review: { model: review-model }
`);
    const config = load(dir);
    const modelFile = path.join(dir, "models.json");
    ensurePiModels(config.pi, modelFile);
    expect(effectivePiModel(config.pi)).toBe("gateway/fix-model");
    expect(effectiveReviewModel(config)).toBe("gateway/review-model");
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

  it("旧配置与覆盖文件无法切回已移除的后端，仍按 Pi 配置选择模型", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "config.yaml"), `
agent: { backend: codex }
codex: { model: old-model, reasoning_effort: invalid }
pi:
  provider: { id: gateway, model_id: fix-model }
review: { backend: codex }
`);
    fs.writeFileSync(path.join(dir, "overrides.yaml"), `
agent: { backend: codex }
codex: { model: obsolete-model }
pi:
  provider: { model_id: current-model }
review: { backend: codex, model: review-model }
`);
    const config = load(dir);
    expect(config).not.toHaveProperty("agent");
    expect(config).not.toHaveProperty("codex");
    expect(config.review).not.toHaveProperty("backend");
    expect(effectivePiModel(config.pi)).toBe("gateway/current-model");
    expect(effectiveReviewModel(config)).toBe("gateway/review-model");
  });

  it("保存清除旧后端设置并保留 Pi、评审和连接配置", () => {
    const dir = tempDir();
    const settingsPath = path.join(dir, "overrides.yaml");
    fs.writeFileSync(settingsPath, `
agent: { backend: codex }
codex: { model: old-model }
pi:
  provider: { id: gateway, model_id: fix-model }
review: { backend: codex, enabled: false, model: review-model }
p4: { client: existing-client }
tapd: { backend: mcp }
`);
    configModule.saveSettingsOverrides({ pi: { provider: { model_id: "new-model" } } }, settingsPath);
    expect(configModule.readSettingsOverrides(settingsPath)).toEqual({
      pi: { provider: { id: "gateway", model_id: "new-model" } },
      review: { enabled: false, model: "review-model" },
      p4: { client: "existing-client" },
      tapd: { backend: "mcp" },
    });
    expect(effectivePiModel(load(dir).pi)).toBe("gateway/new-model");
  });

  it("评审默认沿用修复模型，无 provider 时保留默认模型或显式模型名", () => {
    const config = load(tempDir());
    expect(effectiveReviewModel(config)).toBe("");
    config.review.model = "review-model";
    expect(effectiveReviewModel(config)).toBe("review-model");
    config.pi.provider = { id: "gateway", model_id: "fix-model" };
    config.review.model = " ";
    expect(effectiveReviewModel(config)).toBe("gateway/fix-model");
  });

  it("设置接口忽略旧后端请求，正常保存 Pi 和独立评审模型且不暴露密钥", async () => {
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
    const posted = await response.json();
    const fetched = await (await fetch(url)).json();
    expect(fetched).toEqual(posted);
    expect(fetched).not.toHaveProperty("agent");
    expect(fetched).not.toHaveProperty("codex");
    expect(fetched.review).not.toHaveProperty("backend");
    expect(fetched.pi.effective_model).toBe("gateway/fix-model");
    expect(fetched.pi.provider.has_api_key).toBe(true);
    expect(JSON.stringify(fetched)).not.toContain("test-secret");
    expect(effectiveReviewModel(config)).toBe("gateway/review-model");
    const reloaded = load(dir);
    expect(effectivePiModel(reloaded.pi)).toBe("gateway/fix-model");
    expect(reloaded.review.enabled).toBe(false);
    expect(reloaded.review).not.toHaveProperty("backend");
    config.pi.provider!.api_key = undefined;
    vi.stubEnv("PI_API_KEY", "env-secret");
    const envSettings = await (await fetch(url)).json();
    expect(envSettings.pi.provider.has_api_key).toBe(true);
    expect(JSON.stringify(envSettings)).not.toContain("env-secret");
  });
});
