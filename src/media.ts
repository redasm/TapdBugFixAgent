import type { Bug } from "./models.js";

export type AgentMediaKind = "image" | "video";

export interface AgentMediaInput {
  kind: AgentMediaKind;
  url: string;
  name?: string;
}

export interface TapdMediaReference extends AgentMediaInput {
  attachmentId?: string;
}

const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const VIDEO_EXT_RE = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)(?:$|[?#])/i;

const decodeHtmlAttribute = (value: string): string => value
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .trim();

const mediaKind = (name: string, mime = ""): AgentMediaKind | undefined => {
  if (/^image\//i.test(mime) || IMAGE_EXT_RE.test(name)) return "image";
  if (/^video\//i.test(mime) || VIDEO_EXT_RE.test(name)) return "video";
  return undefined;
};

const textField = (raw: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
};

const addReference = (
  out: TapdMediaReference[],
  seen: Set<string>,
  ref: TapdMediaReference,
): void => {
  const url = decodeHtmlAttribute(ref.url);
  const attachmentId = ref.attachmentId?.trim();
  if (!url && !attachmentId) return;
  const key = `${ref.kind}\0${attachmentId || url}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ ...ref, url, attachmentId: attachmentId || undefined });
};

/** 从 TAPD 原始 HTML 和附件字段提取媒体引用；相对地址稍后由 TAPD MCP 换成临时 URL。 */
export function extractTapdMediaReferences(bug: Bug): TapdMediaReference[] {
  const out: TapdMediaReference[] = [];
  const seen = new Set<string>();
  const html = String(bug.raw?.description ?? "");
  for (const match of html.matchAll(/<(img|video|source)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\2[^>]*>/gis)) {
    const tag = match[1].toLowerCase();
    addReference(out, seen, {
      kind: tag === "img" ? "image" : "video",
      url: match[3],
    });
  }
  for (const match of html.matchAll(/<video\b[^>]*?\bposter\s*=\s*(["'])(.*?)\1[^>]*>/gis)) {
    addReference(out, seen, { kind: "image", url: match[2] });
  }
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gis)) {
    const url = match[2];
    const kind = mediaKind(url);
    if (kind) addReference(out, seen, { kind, url });
  }

  const rawAttachments = bug.raw?.attachments ?? bug.raw?.attachment_list;
  for (const item of Array.isArray(rawAttachments) ? rawAttachments : []) {
    if (!item || typeof item !== "object") continue;
    const data = item as Record<string, unknown>;
    const name = textField(data, ["name", "filename", "file_name", "attachment_name", "title"]);
    const mime = textField(data, ["mime_type", "mimetype", "content_type", "type"]);
    const url = textField(data, ["download_url", "url", "path"]);
    const kind = mediaKind(name || url, mime);
    if (!kind) continue;
    addReference(out, seen, {
      kind,
      url,
      name: name || undefined,
      attachmentId: textField(data, ["id", "attachment_id", "file_id"]) || undefined,
    });
  }
  return out;
}

export function mediaLinksPrompt(media: AgentMediaInput[]): string {
  if (!media.length) return "";
  return [
    "# TAPD 多媒体证据",
    "以下 URL 同时会尝试作为模型原生多模态输入发送。若当前接口不支持多模态块，请仍将它们作为普通链接线索使用：",
    ...media.map((item) => `- ${item.kind === "image" ? "图片" : "视频"}${item.name ? `（${item.name}）` : ""}: ${item.url}`),
  ].join("\n");
}

const withContentArray = (message: Record<string, unknown>): Record<string, unknown>[] => {
  if (Array.isArray(message.content)) return [...message.content] as Record<string, unknown>[];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return [];
};

/** Pi 的 before_provider_request 钩子使用：不改 Pi 本体，直接向网关 payload 注入远程媒体 URL。 */
export function injectMediaIntoProviderPayload(
  payload: unknown,
  media: AgentMediaInput[],
  api = "anthropic-messages",
): unknown {
  if (!payload || typeof payload !== "object" || !media.length) return payload;
  const root = payload as Record<string, unknown>;
  if (api === "openai-responses") {
    const serialized = JSON.stringify(root.input ?? "");
    const additions = media.filter((item) => !serialized.includes(item.url)).map((item) =>
      item.kind === "image"
        ? { type: "input_image", image_url: item.url }
        : { type: "video_url", video_url: { url: item.url } });
    if (!additions.length) return payload;

    if (typeof root.input === "string") {
      return {
        ...root,
        input: [{
          role: "user",
          content: [{ type: "input_text", text: root.input }, ...additions],
        }],
      };
    }
    if (!Array.isArray(root.input)) return payload;
    const input = root.input.map((item) =>
      item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : item);
    const target = [...input].reverse().find((item) =>
      item && typeof item === "object" && (item as Record<string, unknown>).role === "user") as
        Record<string, unknown> | undefined;
    if (!target) return payload;
    target.content = [...withResponsesContentArray(target), ...additions];
    return { ...root, input };
  }
  if (!Array.isArray(root.messages)) return payload;
  const messages = root.messages.map((item) =>
    item && typeof item === "object" ? { ...(item as Record<string, unknown>) } : item);
  const target = messages.find((item) =>
    item && typeof item === "object" && (item as Record<string, unknown>).role === "user") as
      Record<string, unknown> | undefined;
  if (!target) return payload;
  const serialized = JSON.stringify(target.content ?? "");
  const additions = media.filter((item) => !serialized.includes(item.url)).map((item) => {
    if (api === "anthropic-messages") {
      return item.kind === "image"
        ? { type: "image", source: { type: "url", url: item.url } }
        : { type: "video_url", video_url: { url: item.url } };
    }
    return item.kind === "image"
      ? { type: "image_url", image_url: { url: item.url } }
      : { type: "video_url", video_url: { url: item.url } };
  });
  if (!additions.length) return payload;
  target.content = [...withContentArray(target), ...additions];
  return { ...root, messages };
}

const withResponsesContentArray = (message: Record<string, unknown>): Record<string, unknown>[] => {
  if (Array.isArray(message.content)) return [...message.content] as Record<string, unknown>[];
  if (typeof message.content === "string") return [{ type: "input_text", text: message.content }];
  return [];
};

/** Codex 网关代理使用：按实际 payload 协议注入，不按模型名称猜测多模态能力。 */
export function injectMediaIntoCodexPayload(
  payload: unknown,
  media: AgentMediaInput[],
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const root = payload as Record<string, unknown>;
  if (Object.hasOwn(root, "input")) {
    return injectMediaIntoProviderPayload(root, media, "openai-responses");
  }
  if (Array.isArray(root.messages)) {
    return injectMediaIntoProviderPayload(root, media, "openai-chat");
  }
  return payload;
}

export function isMediaCapabilityError(text: string): boolean {
  return /(?:unsupported|invalid).*?(?:image|video|content)|(?:image|video).*?(?:unsupported|not supported|invalid)|image_(?:fetch|download)_failed|could not reach the image host/i.test(text);
}
