import { DomainError } from "@/lib/shared-domain";
import { getMediaGatewayEnabled, recordGatewayCallOutcome, type GatewayTrafficCategory } from "@/lib/db";

export type MediaGatewayCategory = Extract<GatewayTrafficCategory, "runpod_api" | "runpod_s3" | "comfyui_api" | "huggingface_api">;

/**
 * Phase 14 -- the one toggle for every outbound media-generation call (RunPod REST, the S3 API,
 * ComfyUI on a pod), checked inside each child's request function so a new caller cannot forget
 * it (AGENTS.md §G, the same shape as `assertWikipediaReadsAuthorized`). Records one traffic
 * event per real attempt, allowed or blocked.
 */
export async function assertMediaGatewayAuthorized(category: MediaGatewayCategory): Promise<void> {
  if (await getMediaGatewayEnabled()) {
    await recordGatewayCallOutcome(category, "allowed");
    return;
  }
  await recordGatewayCallOutcome(category, "blocked");
  throw new DomainError({
    code: "media_gateway_disabled",
    message: 'The media gateway is disabled -- the "Media gateway" toggle in Servers → Setup is off.',
    details: { category },
  });
}

export type Authorize = (category: MediaGatewayCategory) => Promise<void>;

/** BL-144: the toggle's state without recording a traffic event, for re-checking an open stream. */
export async function isMediaGatewayEnabled(): Promise<boolean> {
  return getMediaGatewayEnabled();
}
