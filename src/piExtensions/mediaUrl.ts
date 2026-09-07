import type { AgentMediaInput } from "../media.js";
import { injectMediaIntoProviderPayload } from "../media.js";

interface PiExtensionApi {
  on(
    event: "before_provider_request",
    handler: (
      event: { payload: unknown },
      context: { model?: { api?: string } },
    ) => unknown,
  ): void;
}

const mediaFromEnv = (): AgentMediaInput[] => {
  const raw = process.env.TAPD_BUGFIX_MEDIA_INPUTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AgentMediaInput => Boolean(
      item && typeof item === "object"
        && ((item as AgentMediaInput).kind === "image" || (item as AgentMediaInput).kind === "video")
        && typeof (item as AgentMediaInput).url === "string",
    ));
  } catch {
    return [];
  }
};

export default function mediaUrlExtension(pi: PiExtensionApi): void {
  const media = mediaFromEnv();
  if (!media.length) return;
  pi.on("before_provider_request", (event, context) =>
    injectMediaIntoProviderPayload(event.payload, media, context.model?.api));
}
