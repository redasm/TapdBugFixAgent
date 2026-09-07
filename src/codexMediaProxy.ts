import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";

import {
  injectMediaIntoCodexPayload,
  isMediaCapabilityError,
  type AgentMediaInput,
} from "./media.js";

const requestBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const upstreamUrl = (baseUrl: URL, requestUrl = "/"): URL => {
  const incoming = new URL(requestUrl, "http://codex.local");
  const prefix = baseUrl.pathname.replace(/\/$/, "");
  const target = new URL(baseUrl);
  target.pathname = prefix && incoming.pathname.startsWith(`${prefix}/`)
    ? incoming.pathname
    : `${prefix}${incoming.pathname.startsWith("/") ? "" : "/"}${incoming.pathname}`;
  target.search = incoming.search;
  return target;
};

const forwardedHeaders = (headers: IncomingHttpHeaders, target: URL, body: Buffer): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || /^(?:host|connection|content-length)$/i.test(key)) continue;
    out[key] = value;
  }
  out.host = target.host;
  out["content-length"] = String(body.length);
  return out;
};

const sendUpstream = (
  method: string,
  target: URL,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<IncomingMessage> => new Promise((resolve, reject) => {
  const transport = target.protocol === "https:" ? https : http;
  const request = transport.request(target, {
    method,
    headers: forwardedHeaders(headers, target, body),
  }, resolve);
  request.once("error", reject);
  request.end(body);
});

const responseBody = async (response: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const copyResponseHeaders = (headers: IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || /^(?:connection|content-length|transfer-encoding)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
};

const mayRetryWithoutMedia = (status: number, body: Buffer): boolean =>
  [415, 422].includes(status) || isMediaCapabilityError(body.toString("utf8"));

export interface CodexMediaProxy {
  baseUrl: string;
  close(): Promise<void>;
  degraded(): boolean;
}

/**
 * 在 Codex CLI 与兼容网关之间注入远程媒体 URL。代理只改本轮第一个可识别的模型请求；
 * 网关拒绝新增内容块时，立即使用未修改的原请求重试，保留 Codex 的完整工具调用循环。
 */
export async function startCodexMediaProxy(
  baseUrl: string,
  media: AgentMediaInput[],
): Promise<CodexMediaProxy> {
  const upstream = new URL(baseUrl);
  let injectionPending = true;
  let usedFallback = false;
  const server = http.createServer(async (request, response) => {
    try {
      const originalBody = await requestBody(request);
      let outgoingBody = originalBody;
      let injected = false;
      if (injectionPending && originalBody.length && /json/i.test(String(request.headers["content-type"] ?? ""))) {
        try {
          const originalPayload = JSON.parse(originalBody.toString("utf8")) as unknown;
          const nextPayload = injectMediaIntoCodexPayload(originalPayload, media);
          if (nextPayload !== originalPayload) {
            outgoingBody = Buffer.from(JSON.stringify(nextPayload));
            injected = true;
            injectionPending = false;
          }
        } catch {
          // 非 JSON 或未知协议保持透传；后续请求仍可尝试注入。
        }
      }

      const target = upstreamUrl(upstream, request.url);
      let upstreamResponse = await sendUpstream(request.method ?? "POST", target, request.headers, outgoingBody);
      if (injected && (upstreamResponse.statusCode ?? 500) >= 400) {
        const rejectedBody = await responseBody(upstreamResponse);
        if (mayRetryWithoutMedia(upstreamResponse.statusCode ?? 500, rejectedBody)) {
          usedFallback = true;
          upstreamResponse = await sendUpstream(request.method ?? "POST", target, request.headers, originalBody);
        } else {
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...copyResponseHeaders(upstreamResponse.headers),
            "content-length": String(rejectedBody.length),
          });
          response.end(rejectedBody);
          return;
        }
      }

      response.writeHead(upstreamResponse.statusCode ?? 502, copyResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Codex media proxy: ${(error as Error).message}` } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("无法启动 Codex 多媒体 URL 代理");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
    degraded: () => usedFallback,
  };
}
