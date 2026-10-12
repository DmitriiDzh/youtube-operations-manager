import { z } from "zod";
import { DEFAULT_LIVE_STREAMS_SETTINGS, DomainError, LIVE_ENCODERS, type LiveStreamsSettings } from "./contracts";
import { parseWithSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.1/§3.12, ADR 0036 §1-2) -- this computer's live-streams settings. The module switch can be
// turned on only where a stream can be hosted: the Mac running as the system service (`YTOM_SERVICE_MODE=1`), which keeps
// running without a login. Every other computer shows streams read-only.
// ---------------------------------------------------------------------------

const settingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    bufferDepth: z.number().int().min(1).max(6),
    warnBelowGb: z.number().min(1).max(1000),
    refuseBelowGb: z.number().min(1).max(1000),
    bitrateKbps: z.number().int().min(1000).max(12000),
    encoder: z.enum(LIVE_ENCODERS),
    alertMinutes: z.number().int().min(1).max(60),
    ffmpegDir: z.string().trim().min(1).max(500).nullable(),
  })
  .partial()
  .strict();

/** Where a stream can run: the Mac's system service. A reason in plain words otherwise. */
export function liveStreamsHost(env: { platform: string; serviceMode: string | undefined }): { ok: true } | { ok: false; reason: string } {
  if (env.platform !== "darwin") return { ok: false, reason: "Live streams run only on the Mac." };
  if (env.serviceMode !== "1") return { ok: false, reason: "Live streams run only when the app runs as the Mac's system service (it keeps running without a login)." };
  return { ok: true };
}

/** Forgiving per field: a bad stored value falls back to its own default only. */
export function liveStreamsSettingsFromJson(json: string | null): LiveStreamsSettings {
  let stored: Record<string, unknown> = {};
  try {
    stored = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  const settings: LiveStreamsSettings = { ...DEFAULT_LIVE_STREAMS_SETTINGS };
  for (const key of Object.keys(DEFAULT_LIVE_STREAMS_SETTINGS) as Array<keyof LiveStreamsSettings>) {
    const parsed = settingsPatchSchema.safeParse({ [key]: stored[key] });
    if (parsed.success && parsed.data[key] !== undefined) (settings as Record<string, unknown>)[key] = parsed.data[key];
  }
  if (settings.refuseBelowGb >= settings.warnBelowGb) {
    settings.warnBelowGb = DEFAULT_LIVE_STREAMS_SETTINGS.warnBelowGb;
    settings.refuseBelowGb = DEFAULT_LIVE_STREAMS_SETTINGS.refuseBelowGb;
  }
  return settings;
}

export function createLiveStreamsSettings(deps: {
  getJson(): Promise<string | null>;
  setJson(json: string): Promise<void>;
  host(): { ok: true } | { ok: false; reason: string };
}) {
  return {
    async get(): Promise<LiveStreamsSettings & { host: { ok: true } | { ok: false; reason: string } }> {
      return { ...liveStreamsSettingsFromJson(await deps.getJson()), host: deps.host() };
    },

    async update(input: unknown): Promise<LiveStreamsSettings> {
      const patch = parseWithSchema(settingsPatchSchema, input, "live streams settings");
      const next: LiveStreamsSettings = { ...liveStreamsSettingsFromJson(await deps.getJson()), ...patch };
      if (patch.enabled === true) {
        const host = deps.host();
        if (!host.ok) throw new DomainError({ code: "live_streams_host_unsupported", message: host.reason });
      }
      if (next.refuseBelowGb >= next.warnBelowGb) {
        throw new DomainError({ code: "validation_failed", message: "The refuse level must be below the warning level", details: { warnBelowGb: next.warnBelowGb, refuseBelowGb: next.refuseBelowGb } });
      }
      await deps.setJson(JSON.stringify(next));
      return next;
    },
  };
}
