import { z } from "zod";
import { VIDEOS_FOLDER } from "@/lib/workspace-videos";
import { DomainError, MAX_AUDIO_CHANNELS, SUPPORTED_AUDIO_SAMPLE_RATES, type ProbeResult } from "./contracts";
import { parseWithSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-234 (FO-REQ-0048 as changed by the owner, msgs 3792/3793/3795; ADR 0056) -- the stream's second source: a LIBRARY of
// segments the Operator's generator writes into the channel workspace, `04 Videos/Live Segments/seg-<seq>.mp4` with a sidecar
// `seg-<seq>.json` and a poster `seg-<seq>.jpg`. The owner selects and orders segments; the selection is the rotation of a stream
// in `segments` mode, played by the same engine as videos (buffer, helper, resume, replay). The library is only read here:
// nothing in this module writes, renames or deletes a library file -- removing a segment from the selection removes its row only.
// No YouTube call: a segment is not a YouTube video (no public-only guard, no duration check against YouTube); ffprobe stays.
// ---------------------------------------------------------------------------

export const LIVE_SOURCE_MODES = ["videos", "segments"] as const;
export type LiveSourceMode = (typeof LIVE_SOURCE_MODES)[number];
/** A stored null (every stream before schema v114) is `videos`. */
export function sourceModeOf(row: { sourceMode?: string | null } | null | undefined): LiveSourceMode {
  return row?.sourceMode === "segments" ? "segments" : "videos";
}

/** The library folder, relative to the channel workspace. */
export const LIBRARY_FOLDER = `${VIDEOS_FOLDER}/Live Segments`;
export const MAX_SEGMENT_SEQ = 999_999;
const SEGMENT_ID = /^seg-(\d{6})$/;
const FILE_NAME = /^seg-(\d{6})\.(mp4|json|jpg)$/;

/** The id a segment has in a pass, the buffer and the helper (a YouTube video id has 11 characters; this one 10). */
export function segmentId(seq: number): string {
  return `seg-${String(seq).padStart(6, "0")}`;
}
export function seqOfSegmentId(id: string): number | null {
  const match = SEGMENT_ID.exec(id);
  return match ? Number(match[1]) : null;
}
export const isSegmentId = (id: string) => SEGMENT_ID.test(id);
export function segmentFile(seq: number, kind: "mp4" | "json" | "jpg"): string {
  return `${LIBRARY_FOLDER}/${segmentId(seq)}.${kind}`;
}

const trackSchema = z.object({ title: z.string().max(300), startSec: z.number().finite().min(0) }).passthrough();
/** The sidecar as the generator writes it; unknown keys (`scene`, ...) are allowed and ignored. */
export const sidecarSchema = z
  .object({
    seq: z.number().int().min(0).max(MAX_SEGMENT_SEQ),
    durationSec: z.number().finite().positive().max(24 * 3600),
    createdAt: z.string().min(1).max(64),
    title: z.string().max(300).optional(),
    posterFile: z.string().max(200).optional(),
    tracks: z.array(trackSchema).max(2000).default([]),
  })
  .passthrough();

export type SegmentTrack = { title: string; startSec: number };
export type Sidecar = { seq: number; durationSec: number; createdAt: string; title: string | null; tracks: SegmentTrack[] };

/** A sidecar's text for the file named `seq`: refused unless it is JSON of the contract with the same `seq`. */
export function parseSidecar(text: string, expectedSeq: number): { ok: true; sidecar: Sidecar } | { ok: false; reason: "not_json" | "invalid" | "seq_mismatch" } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  const parsed = sidecarSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.seq !== expectedSeq) return { ok: false, reason: "seq_mismatch" };
  const tracks = parsed.data.tracks.map((t) => ({ title: t.title, startSec: t.startSec })).sort((a, b) => a.startSec - b.startSec);
  const title = parsed.data.title?.trim() ? parsed.data.title.trim() : null;
  return { ok: true, sidecar: { seq: parsed.data.seq, durationSec: parsed.data.durationSec, createdAt: parsed.data.createdAt, title, tracks } };
}

/**
 * The library folder's file names -> the complete segments in it: a `seg-<seq>.mp4` with its `seg-<seq>.json`, neither still being
 * written (a `.part` beside it). A poster is optional. Sorted by seq.
 */
export function completeSegments(names: readonly string[]): Array<{ seq: number; poster: boolean }> {
  const files = new Map<number, Set<string>>();
  const writing = new Set<number>();
  for (const name of names) {
    const part = /^seg-(\d{6})\.(mp4|json|jpg)\.part$/.exec(name);
    if (part) {
      writing.add(Number(part[1]));
      continue;
    }
    const match = FILE_NAME.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!files.has(seq)) files.set(seq, new Set());
    files.get(seq)!.add(match[2]);
  }
  return [...files.entries()]
    .filter(([seq, kinds]) => kinds.has("mp4") && kinds.has("json") && !writing.has(seq))
    .map(([seq, kinds]) => ({ seq, poster: kinds.has("jpg") }))
    .sort((a, b) => a.seq - b.seq);
}

/** The track playing at `offsetSeconds` into a segment: the last one started at or before it; null before the first or without tracks. */
export function trackAt(tracks: readonly SegmentTrack[], offsetSeconds: number): SegmentTrack | null {
  let current: SegmentTrack | null = null;
  for (const track of tracks) {
    if (track.startSec <= offsetSeconds) current = track;
    else break;
  }
  return current;
}

export type SegmentMediaProblem = "no_video_stream" | "audio_unsupported" | "duration_unknown";

/**
 * The ffprobe check of a segment (the request: "keep an ffprobe check"): a picture, AAC sound the encoder copies into FLV
 * (44.1/48 kHz, at most 2 channels) and a known, positive duration. No comparison with YouTube: a segment is not a YouTube video.
 */
export function checkSegmentMedia(probe: Pick<ProbeResult, "durationSeconds" | "video" | "audio">): SegmentMediaProblem | null {
  if (!probe.video) return "no_video_stream";
  const audio = probe.audio;
  if (!audio || audio.codec !== "aac" || audio.sampleRate === null || !(SUPPORTED_AUDIO_SAMPLE_RATES as readonly number[]).includes(audio.sampleRate)) return "audio_unsupported";
  if (audio.channels === null || audio.channels < 1 || audio.channels > MAX_AUDIO_CHANNELS) return "audio_unsupported";
  if (probe.durationSeconds === null || !Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) return "duration_unknown";
  return null;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export type LibraryUnavailableReason = "workspace_not_configured" | "workspace_unavailable" | "library_missing";
export type SegmentRefusal = "not_in_library" | "sidecar_invalid" | "file_unavailable" | SegmentMediaProblem;

export type StoredLibrarySegmentRow = {
  channelId: string;
  seq: number;
  rotationIndex: number;
  title: string | null;
  durationSeconds: number | null;
  sidecarDurationSeconds: number | null;
  bytes: number | null;
  tracksJson: string | null;
  checkStatus: "ok" | "refused" | "unchecked";
  checkReason: string | null;
  checkedAt: Date | null;
  addedAt: Date;
};

export type LibraryDependencies = {
  /**
   * The library folder's entries: `unavailable` when the channel has no workspace here, the workspace cannot be read (the drive is
   * away) or it has no library folder. Read-only.
   */
  listLibrary(channelId: string): Promise<{ ok: true; names: string[] } | { ok: false; reason: LibraryUnavailableReason }>;
  /** A library file (workspace-relative) through the workspace rule; null when missing or unreadable. Read-only. */
  readText(channelId: string, relativePath: string, maxBytes: number): Promise<string | null>;
  resolve(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
  probe(path: string): Promise<ProbeResult>;
  store: {
    getStream(channelId: string): Promise<{ sourceMode?: string | null; positionIndex: number; positionOffsetSeconds: number; passOrderJson: string | null } | null>;
    setSourceMode(channelId: string, mode: LiveSourceMode): Promise<boolean>;
    list(channelId: string): Promise<StoredLibrarySegmentRow[]>;
    upsert(row: StoredLibrarySegmentRow): Promise<void>;
    update(channelId: string, seq: number, set: Partial<Omit<StoredLibrarySegmentRow, "channelId" | "seq" | "addedAt">>): Promise<boolean>;
    remove(channelId: string, seq: number): Promise<boolean>;
    setOrder(channelId: string, seqs: readonly number[]): Promise<boolean>;
  };
  event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  clock: () => Date;
};

const SIDECAR_MAX_BYTES = 1024 * 1024;
const seqSchema = z.number().int().min(0).max(MAX_SEGMENT_SEQ);
export const setSourceModeSchema = z.object({ mode: z.enum(LIVE_SOURCE_MODES) }).strict();
export const addSegmentsSchema = z.object({ seqs: z.array(seqSchema).min(1).max(500) }).strict();
export const removeSegmentSchema = z.object({ seq: seqSchema }).strict();
export const reorderSegmentsSchema = z.object({ seqs: z.array(seqSchema).min(1).max(500) }).strict();

export type LibrarySegmentView = {
  seq: number;
  id: string;
  title: string | null;
  durationSeconds: number;
  createdAt: string;
  tracks: SegmentTrack[];
  poster: boolean;
  selected: boolean;
};

export type SelectedSegmentView = {
  seq: number;
  id: string;
  title: string | null;
  rotationIndex: number;
  durationSeconds: number | null;
  bytes: number | null;
  tracks: SegmentTrack[];
  check: { status: "ok" | "refused" | "unchecked"; reason: string | null; checkedAt: string | null };
};

function tracksOf(json: string | null): SegmentTrack[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is SegmentTrack => Boolean(t) && typeof (t as SegmentTrack).title === "string" && typeof (t as SegmentTrack).startSec === "number")
      : [];
  } catch {
    return [];
  }
}

export function selectedView(row: StoredLibrarySegmentRow): SelectedSegmentView {
  return {
    seq: row.seq,
    id: segmentId(row.seq),
    title: row.title,
    rotationIndex: row.rotationIndex,
    durationSeconds: row.durationSeconds ?? row.sidecarDurationSeconds,
    bytes: row.bytes,
    tracks: tracksOf(row.tracksJson),
    check: { status: row.checkStatus, reason: row.checkReason, checkedAt: row.checkedAt?.toISOString() ?? null },
  };
}

const UNAVAILABLE_TEXT: Record<LibraryUnavailableReason, string> = {
  workspace_not_configured: "this channel has no workspace folder on this computer (Settings → Channels)",
  workspace_unavailable: "the channel workspace cannot be read (is its drive connected?)",
  library_missing: `the workspace has no "${LIBRARY_FOLDER}" folder`,
};

export function createSegmentLibrary(deps: LibraryDependencies) {
  /** One segment as the library holds it now: its sidecar, its file, ffprobe. A refusal, or the facts to store. */
  async function inspect(
    channelId: string,
    seq: number
  ): Promise<{ ok: true; sidecar: Sidecar; durationSeconds: number; bytes: number } | { ok: false; reason: SegmentRefusal; detail: string; sidecar?: Sidecar }> {
    const text = await deps.readText(channelId, segmentFile(seq, "json"), SIDECAR_MAX_BYTES);
    if (text === null) return { ok: false, reason: "not_in_library", detail: `${segmentId(seq)}.json is not in the library` };
    const parsed = parseSidecar(text, seq);
    if (!parsed.ok) return { ok: false, reason: "sidecar_invalid", detail: `${segmentId(seq)}.json: ${parsed.reason}` };
    const file = await deps.resolve(channelId, segmentFile(seq, "mp4"));
    if (!file) return { ok: false, reason: "file_unavailable", detail: `${segmentId(seq)}.mp4 is not in the library`, sidecar: parsed.sidecar };
    let probe: ProbeResult;
    try {
      probe = await deps.probe(file.path);
    } catch (error) {
      return { ok: false, reason: "file_unavailable", detail: `${segmentId(seq)}.mp4 could not be read as a video (${error instanceof Error ? error.message : String(error)})`, sidecar: parsed.sidecar };
    }
    const problem = checkSegmentMedia(probe);
    if (problem) return { ok: false, reason: problem, detail: `${segmentId(seq)}.mp4: ${problem}`, sidecar: parsed.sidecar };
    return { ok: true, sidecar: parsed.sidecar, durationSeconds: probe.durationSeconds!, bytes: file.bytes };
  }

  /** The selection's rows; refused when the channel has no stream row yet (its settings were never saved). */
  async function requireStream(channelId: string) {
    const stream = await deps.store.getStream(channelId);
    if (!stream) throw new DomainError({ code: "validation_failed", message: "Save the stream's settings first", details: { channelId } });
    return stream;
  }

  return {
    /** The library as it is now (the owner's dialog): complete segments with a valid sidecar only. Read-only; no ffprobe. */
    async listLibrary(channelId: string): Promise<{ available: boolean; reason: LibraryUnavailableReason | null; message: string | null; folder: string; segments: LibrarySegmentView[]; skipped: number }> {
      const listing = await deps.listLibrary(channelId);
      if (!listing.ok) return { available: false, reason: listing.reason, message: UNAVAILABLE_TEXT[listing.reason], folder: LIBRARY_FOLDER, segments: [], skipped: 0 };
      const selected = new Set((await deps.store.list(channelId)).map((r) => r.seq));
      const segments: LibrarySegmentView[] = [];
      let skipped = 0;
      for (const entry of completeSegments(listing.names)) {
        const text = await deps.readText(channelId, segmentFile(entry.seq, "json"), SIDECAR_MAX_BYTES);
        const parsed = text === null ? null : parseSidecar(text, entry.seq);
        if (!parsed?.ok) {
          skipped += 1;
          continue;
        }
        const s = parsed.sidecar;
        segments.push({ seq: s.seq, id: segmentId(s.seq), title: s.title, durationSeconds: s.durationSec, createdAt: s.createdAt, tracks: s.tracks, poster: entry.poster, selected: selected.has(s.seq) });
      }
      return { available: true, reason: null, message: null, folder: LIBRARY_FOLDER, segments, skipped };
    },

    /** The selection in the owner's order, with each segment's last check. Local only. */
    async selection(channelId: string): Promise<SelectedSegmentView[]> {
      return (await deps.store.list(channelId)).map(selectedView);
    },

    /**
     * The owner's switch between the two sources (the Web UI only: no agent tool reaches it). It applies where rotation edits apply:
     * at the next pass (the one already drawn is dropped, so the next draw is in the new mode) or at once with Restart / a Start.
     */
    async setSourceMode(channelId: string, input: unknown): Promise<{ mode: LiveSourceMode; changed: boolean }> {
      const { mode } = parseWithSchema(setSourceModeSchema, input, "live stream source");
      const stream = await requireStream(channelId);
      const previous = sourceModeOf(stream);
      if (previous === mode) return { mode, changed: false };
      await deps.store.setSourceMode(channelId, mode);
      await deps.event(channelId, "source_mode_changed", { from: previous, to: mode });
      return { mode, changed: true };
    },

    /**
     * Adds segments at the end of the selection, in the given order. Each must be complete in the library now, with a valid sidecar
     * and a file that passes ffprobe; a refused one is listed and adds nothing, the others still go in. One already selected is skipped.
     */
    async addSegments(channelId: string, input: unknown): Promise<{ added: SelectedSegmentView[]; refused: Array<{ seq: number; reason: SegmentRefusal; message: string }> }> {
      const { seqs } = parseWithSchema(addSegmentsSchema, input, "live stream segments");
      await requireStream(channelId);
      const listing = await deps.listLibrary(channelId);
      if (!listing.ok) throw new DomainError({ code: "live_stream_workspace_unavailable", message: `The segment library cannot be read: ${UNAVAILABLE_TEXT[listing.reason]}`, details: { channelId, reason: listing.reason } });
      const complete = new Set(completeSegments(listing.names).map((s) => s.seq));
      const rows = await deps.store.list(channelId);
      const have = new Set(rows.map((r) => r.seq));
      let next = rows.reduce((max, r) => Math.max(max, r.rotationIndex + 1), 0);
      const added: SelectedSegmentView[] = [];
      const refused: Array<{ seq: number; reason: SegmentRefusal; message: string }> = [];
      for (const seq of seqs) {
        if (have.has(seq)) continue;
        have.add(seq);
        if (!complete.has(seq)) {
          refused.push({ seq, reason: "not_in_library", message: `${segmentId(seq)} is not complete in the library (its .mp4 and .json, no .part)` });
          continue;
        }
        const checked = await inspect(channelId, seq);
        if (!checked.ok) {
          refused.push({ seq, reason: checked.reason, message: checked.detail });
          continue;
        }
        const now = deps.clock();
        const row: StoredLibrarySegmentRow = {
          channelId,
          seq,
          rotationIndex: next++,
          title: checked.sidecar.title,
          durationSeconds: checked.durationSeconds,
          sidecarDurationSeconds: checked.sidecar.durationSec,
          bytes: checked.bytes,
          tracksJson: JSON.stringify(checked.sidecar.tracks),
          checkStatus: "ok",
          checkReason: null,
          checkedAt: now,
          addedAt: now,
        };
        await deps.store.upsert(row);
        added.push(selectedView(row));
      }
      if (added.length > 0) await deps.event(channelId, "library_add", { seqs: added.map((a) => a.seq) });
      return { added, refused };
    },

    /** Removes a segment from the selection only: the library file stays. Applied at the next pass (or now, with Restart). */
    async removeSegment(channelId: string, input: unknown): Promise<void> {
      const { seq } = parseWithSchema(removeSegmentSchema, input, "live stream segment");
      if (!(await deps.store.remove(channelId, seq))) {
        throw new DomainError({ code: "live_stream_video_not_found", message: "The segment is not in this stream's selection", details: { seq } });
      }
      await deps.event(channelId, "library_remove", { seq });
    },

    /** The new order must name exactly the selection's segments. Applied at the next pass (or now, with Restart). */
    async reorderSegments(channelId: string, input: unknown): Promise<void> {
      const { seqs } = parseWithSchema(reorderSegmentsSchema, input, "live stream segment order");
      if (!(await deps.store.setOrder(channelId, seqs))) {
        throw new DomainError({ code: "validation_failed", message: "The order must list exactly the selected segments, once each", details: { seqs } });
      }
      await deps.event(channelId, "library_reorder", { seqs });
    },

    /**
     * The `segments` source's recheck (at Start, at Restart, at an encoder start and when the next pass is drawn): the selected
     * segments that can play, in the owner's order, as segment ids. With the library readable, each is checked again (sidecar, file,
     * ffprobe): a missing or unreadable one is left out and logged (`segment_refused`, once per change). With the library unreadable
     * (the drive is away), the last checks stand -- the buffer's copies keep playing, like a video stream without the drive.
     * None playable: refused with the reason (never an empty pass).
     */
    async recheck(channelId: string): Promise<string[]> {
      const rows = await deps.store.list(channelId);
      if (rows.length === 0) {
        throw new DomainError({ code: "live_stream_video_refused", message: "No segment is selected for this stream (choose segments from the library)", details: { channelId, reason: "no_segments_selected" } });
      }
      const listing = await deps.listLibrary(channelId);
      if (!listing.ok) {
        const kept = rows.filter((r) => r.checkStatus === "ok").map((r) => segmentId(r.seq));
        await deps.event(channelId, "segment_library_unavailable", { reason: listing.reason, kept: kept.length });
        if (kept.length === 0) {
          throw new DomainError({ code: "live_stream_video_refused", message: `No selected segment can be played: ${UNAVAILABLE_TEXT[listing.reason]}`, details: { channelId, reason: listing.reason } });
        }
        return kept;
      }
      const complete = new Set(completeSegments(listing.names).map((s) => s.seq));
      const now = deps.clock();
      const playable: string[] = [];
      for (const row of rows) {
        const checked = complete.has(row.seq) ? await inspect(channelId, row.seq) : ({ ok: false, reason: "not_in_library", detail: `${segmentId(row.seq)} is not complete in the library` } as const);
        if (checked.ok) {
          playable.push(segmentId(row.seq));
          await deps.store.update(channelId, row.seq, {
            checkStatus: "ok",
            checkReason: null,
            checkedAt: now,
            title: checked.sidecar.title,
            durationSeconds: checked.durationSeconds,
            sidecarDurationSeconds: checked.sidecar.durationSec,
            bytes: checked.bytes,
            tracksJson: JSON.stringify(checked.sidecar.tracks),
          });
          continue;
        }
        const changed = row.checkStatus !== "refused" || row.checkReason !== checked.reason;
        await deps.store.update(channelId, row.seq, { checkStatus: "refused", checkReason: checked.reason, checkedAt: now });
        if (changed) await deps.event(channelId, "segment_refused", { seq: row.seq, reason: checked.reason });
      }
      if (playable.length === 0) {
        throw new DomainError({ code: "live_stream_video_refused", message: "None of the selected segments can be played (missing from the library or not a playable video)", details: { channelId, reason: "no_playable_segments" } });
      }
      return playable;
    },

    /** The selection as the supervisor's buffer and helper need it: each segment's file and its probed duration. */
    async items(channelId: string): Promise<Array<{ videoId: string; originalPath: string; videoDurationSeconds: null; originalDurationSeconds: number | null; kind: "segment" }>> {
      return (await deps.store.list(channelId)).map((r) => ({
        videoId: segmentId(r.seq),
        originalPath: segmentFile(r.seq, "mp4"),
        videoDurationSeconds: null,
        originalDurationSeconds: r.durationSeconds ?? r.sidecarDurationSeconds,
        kind: "segment" as const,
      }));
    },
  };
}

export type SegmentLibrary = ReturnType<typeof createSegmentLibrary>;

/**
 * The segment source's part of a stream's status (the page and `factory_live_get_status`): the mode, the selection's size and
 * minutes (the segments whose last check passed), the library's availability, and -- in segments mode -- the segment playing and
 * its track from the sidecar, by the helper's position. Pure.
 */
export function segmentSourceStatus(args: {
  channelId: string;
  sourceMode: LiveSourceMode;
  rows: readonly StoredLibrarySegmentRow[];
  library: { ok: true } | { ok: false; reason: LibraryUnavailableReason };
  position: { segmentId: string | null; offsetSeconds: number } | null;
}): {
  channelId: string;
  sourceMode: LiveSourceMode;
  library: { available: boolean; reason: LibraryUnavailableReason | null };
  selection: { segments: number; playable: number; minutes: number };
  current: { seq: number; title: string | null; offsetSeconds: number; track: string | null } | null;
} {
  const playable = args.rows.filter((r) => r.checkStatus === "ok");
  const seconds = playable.reduce((sum, r) => sum + (r.durationSeconds ?? r.sidecarDurationSeconds ?? 0), 0);
  const seq = args.sourceMode === "segments" && args.position?.segmentId ? seqOfSegmentId(args.position.segmentId) : null;
  const row = seq === null ? null : (args.rows.find((r) => r.seq === seq) ?? null);
  const offset = Math.max(0, Math.floor(args.position?.offsetSeconds ?? 0));
  return {
    channelId: args.channelId,
    sourceMode: args.sourceMode,
    library: { available: args.library.ok, reason: args.library.ok ? null : args.library.reason },
    selection: { segments: args.rows.length, playable: playable.length, minutes: Math.round(seconds / 60) },
    current: seq === null ? null : { seq, title: row?.title ?? null, offsetSeconds: offset, track: row ? (trackAt(tracksOf(row.tracksJson), offset)?.title ?? null) : null },
  };
}
