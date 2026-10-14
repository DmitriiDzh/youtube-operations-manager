import { createHash } from "node:crypto";
import { imageKindOf, THUMBNAIL_MAX_BYTES } from "@/lib/youtube-video-fields";
import { DEFAULT_LIVE_VIDEO_SETTINGS, DEFAULT_STREAM_SETTINGS, DomainError, type LiveThumbnail, type LiveVideoSettings } from "./contracts";
import { parseWithSchema, storedVideoSettingsSchema, videoSettingsInputSchema } from "./schemas";
import type { LiveStreamsDependencies } from "./services";

// ---------------------------------------------------------------------------
// BL-186 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §2.1/§2.2/§3.2) -- the stream's own video and broadcast settings: every
// field the API can set (owner msgs 2782/2785), saved on this computer. Local only: nothing here writes to YouTube. Start sends
// the broadcast part at insert (`broadcasts.ts`); the video part waits for spike C (plan §5 stage 3).
// ---------------------------------------------------------------------------

/** A stored value Start can trust, or why it cannot (a stored value never silently becomes the defaults: fail closed). */
export type StoredVideoSettings = { ok: true; settings: LiveVideoSettings | null } | { ok: false; problem: string };

/** Reads the v92 column: null = never saved; anything that does not pass the schema is reported, never guessed. */
export function readStoredVideoSettings(json: string | null | undefined): StoredVideoSettings {
  if (json === null || json === undefined) return { ok: true, settings: null };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, problem: "the saved video settings are not valid JSON" };
  }
  const parsed = storedVideoSettingsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: `the saved video settings are invalid: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  return { ok: true, settings: parsed.data as LiveVideoSettings };
}

export type ThumbnailStore = {
  write(channelId: string, kind: "jpeg" | "png", bytes: Uint8Array): Promise<void>;
  read(channelId: string): Promise<{ kind: "jpeg" | "png"; bytes: Uint8Array } | null>;
  remove(channelId: string): Promise<void>;
};

export type VideoSettingsDependencies = {
  store: Pick<LiveStreamsDependencies["store"], "getStream" | "updateStream" | "upsertStream" | "insertEvent">;
  thumbnails: ThumbnailStore;
  clock: () => Date;
  newId: () => string;
};

export function createStreamVideoSettings(deps: VideoSettingsDependencies) {
  async function event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
    await deps.store.insertEvent({ id: deps.newId(), channelId, at: deps.clock(), kind, detailJson: JSON.stringify(detail) });
  }

  /** The current saved value to build on; a corrupt one is refused (re-saving the whole form replaces it). */
  async function current(channelId: string, allowCorrupt: boolean): Promise<LiveVideoSettings | null> {
    const row = await deps.store.getStream(channelId);
    const stored = readStoredVideoSettings(row?.videoSettingsJson);
    if (!stored.ok) {
      if (allowCorrupt) return null;
      throw new DomainError({ code: "validation_failed", message: `${stored.problem}. Save the video settings again.`, details: { channelId } });
    }
    return stored.settings;
  }

  /** Writes the column; a channel with no stream row yet gets one with the default texts (as `saveSettings` does). */
  async function store(channelId: string, settings: LiveVideoSettings): Promise<void> {
    const now = deps.clock();
    const videoSettingsJson = JSON.stringify(settings);
    const updated = await deps.store.updateStream(channelId, { videoSettingsJson, updatedAt: now });
    if (!updated) {
      await deps.store.upsertStream({ channelId, intent: "off", passNumber: 0, positionIndex: 0, positionOffsetSeconds: 0, createdAt: now, ...DEFAULT_STREAM_SETTINGS, videoSettingsJson, updatedAt: now });
    }
  }

  return {
    /** The saved settings (null = never saved) or the problem with them, for the page. */
    async get(channelId: string): Promise<StoredVideoSettings> {
      return readStoredVideoSettings((await deps.store.getStream(channelId))?.videoSettingsJson);
    },

    /** Local only. The whole form replaces the saved value; the thumbnail (its own upload) is kept. */
    async save(channelId: string, input: unknown): Promise<LiveVideoSettings> {
      const fields = parseWithSchema(videoSettingsInputSchema, input, "live stream video settings");
      const previous = await current(channelId, true);
      const settings: LiveVideoSettings = { v: 1, ...fields, thumbnail: previous?.thumbnail ?? null };
      await store(channelId, settings);
      await event(channelId, "video_settings_saved", { ...fields });
      return settings;
    },

    /** Local only: a JPEG or PNG (by its first bytes) of at most 2 MB, as thumbnails.set accepts. Replaces the previous one. */
    async setThumbnail(channelId: string, bytes: Uint8Array): Promise<LiveThumbnail> {
      if (bytes.length === 0) throw new DomainError({ code: "validation_failed", message: "The image is empty" });
      if (bytes.length > THUMBNAIL_MAX_BYTES) {
        throw new DomainError({ code: "validation_failed", message: "The image is over YouTube's 2 MB thumbnail limit", details: { bytes: bytes.length, max: THUMBNAIL_MAX_BYTES } });
      }
      const kind = imageKindOf(bytes.subarray(0, 8));
      if (kind === "other") throw new DomainError({ code: "validation_failed", message: "The thumbnail must be a JPEG or PNG image" });
      const previous = (await current(channelId, false)) ?? { ...DEFAULT_LIVE_VIDEO_SETTINGS };
      await deps.thumbnails.write(channelId, kind, bytes);
      const thumbnail: LiveThumbnail = { kind, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), savedAt: deps.clock().toISOString() };
      await store(channelId, { ...previous, thumbnail });
      await event(channelId, "thumbnail_saved", { kind, bytes: thumbnail.bytes, sha256: thumbnail.sha256 });
      return thumbnail;
    },

    /** Local only: the stream gets no thumbnail of its own (YouTube's automatic one stays). */
    async clearThumbnail(channelId: string): Promise<void> {
      const previous = await current(channelId, false);
      await deps.thumbnails.remove(channelId);
      if (previous?.thumbnail) {
        await store(channelId, { ...previous, thumbnail: null });
        await event(channelId, "thumbnail_removed", { sha256: previous.thumbnail.sha256 });
      }
    },

    /** The saved image for the page's preview, only when it is still the one the settings name (same hash). */
    async readThumbnail(channelId: string): Promise<{ kind: "jpeg" | "png"; bytes: Uint8Array } | null> {
      const saved = await current(channelId, true);
      if (!saved?.thumbnail) return null;
      const file = await deps.thumbnails.read(channelId);
      if (!file || createHash("sha256").update(file.bytes).digest("hex") !== saved.thumbnail.sha256) return null;
      return file;
    },
  };
}

export type StreamVideoSettings = ReturnType<typeof createStreamVideoSettings>;
