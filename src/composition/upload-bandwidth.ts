import { createUploadBandwidthGovernor, registerUploadBandwidthGovernor, type LiveLoad, type UploadBandwidthEvent, type UploadBandwidthGovernor } from "@/lib/upload-bandwidth";

/**
 * BL-233 (FO-REQ-0047, AGENTS.md §M): the upload's share of this computer's uplink while live streams run here, composed at the
 * app layer from the shared `upload-bandwidth` module -- publishing and live-streams import each other nowhere. The governor
 * reads the streams' settings and encoders through live-streams' own reader (local files and settings only) and notes each hold
 * and release in the starving stream's history and the server log. One governor per process, registered for the readers (the
 * Operator's status, the Web UI). Live streams switched off: unlimited; a failed read keeps the last state (unlimited if none).
 */
export function createUploadBandwidth(): UploadBandwidthGovernor {
  const governor = createUploadBandwidthGovernor({
    async load(): Promise<LiveLoad> {
      const { readLiveUploadLoad } = await import("@/lib/live-streams");
      const load = await readLiveUploadLoad();
      return {
        streamsOn: load.streamsOn,
        capMbps: load.capMbps,
        guardMinutes: load.guardMinutes,
        encoders: load.encoders.map((e) => ({
          channelId: e.channelId,
          intentOn: e.intentOn,
          running: e.running,
          sampledAt: e.sampledAt ?? 0,
          progressAt: e.progressAt,
          outTimeSeconds: e.outTimeSeconds,
          speed: e.speed,
        })),
      };
    },
    clock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onEvent: (event) => noteEvent(event),
    onLoadError: (error) => console.warn(`[publishing] live streams not read for the upload limit: ${error instanceof Error ? error.message : String(error)}`),
  });
  registerUploadBandwidthGovernor(governor);
  return governor;
}

async function noteEvent(event: UploadBandwidthEvent): Promise<void> {
  if (event.kind === "upload_held") {
    console.warn(`[publishing] upload held: the stream of ${event.channelId} sends at ${event.speed?.toFixed(3) ?? "?"}x`);
    const { noteLiveStreamEvent } = await import("@/lib/live-streams");
    await noteLiveStreamEvent(event.channelId, "upload_held", { speed: event.speed });
    return;
  }
  console.warn(`[publishing] upload released (${event.reason}) after ${Math.round(event.heldMs / 60_000)} min`);
  if (event.channelId) {
    const { noteLiveStreamEvent } = await import("@/lib/live-streams");
    await noteLiveStreamEvent(event.channelId, "upload_released", { releaseReason: event.reason, heldMinutes: Math.round(event.heldMs / 60_000) });
  }
}
