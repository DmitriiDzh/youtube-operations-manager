import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { MediaProbe } from "@/lib/ffmpeg-host";
import type { GuardRefusal } from "./rotation";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md, ADR 0036) -- a channel's 24/7 live stream of its own public videos,
// sent from the Mac. A separate feature module (AGENTS.md §M): it depends on the shared gateways, `ffmpeg-host`,
// `workspace-exchange` and the channel store, and nothing depends on it. Switched off, it runs no timer and no process.
// ---------------------------------------------------------------------------

export const LIVE_PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;
export type LivePrivacy = (typeof LIVE_PRIVACY_STATUSES)[number];
export const LIVE_ORDER_MODES = ["sequence", "shuffle"] as const;
export type LiveOrderMode = (typeof LIVE_ORDER_MODES)[number];

/** Why a video cannot enter (or stay in) a rotation. */
export type VideoRefusal =
  | GuardRefusal
  | "not_channel_video"
  | "file_unavailable"
  | "no_video_stream"
  | "audio_unsupported"
  | "duration_unknown"
  | "duration_mismatch";

/** §3.4/§3.5: the original must be within this many seconds of the YouTube video's duration. */
export const DURATION_TOLERANCE_SECONDS = 1;
/** AAC at these rates is what the encoder copies into FLV unchanged (§1.3: AAC at 44.1 or 48 kHz). */
export const SUPPORTED_AUDIO_SAMPLE_RATES = [44100, 48000] as const;
export const MAX_AUDIO_CHANNELS = 2;
/** An override of the public-only guard needs a reason at least this long. */
export const MIN_OVERRIDE_REASON_LENGTH = 5;

export type StreamSettingsInput = {
  title: string;
  description: string;
  privacyStatus: LivePrivacy;
  madeForKids: boolean;
  orderMode: LiveOrderMode;
};

export type RotationVideoView = {
  videoId: string;
  title: string | null;
  rotationIndex: number;
  originalPath: string;
  videoDurationSeconds: number | null;
  originalDurationSeconds: number | null;
  originalBytes: number | null;
  check: { status: "ok" | "refused" | "unchecked"; reason: string | null; checkedAt: string | null };
  override: { reason: string; at: string } | null;
};

export type StreamView = {
  channelId: string;
  intent: "on" | "off";
  settings: StreamSettingsInput;
  streamId: string | null;
  broadcastId: string | null;
  onSince: string | null;
};

export type SourceItemResult = { videoId: string; file: string; status: "accepted" | "refused"; reason?: VideoRefusal; detail?: string };

/** What the module needs from YouTube about a video (a fresh read, never the synced copy -- §3.4). */
export type VideoFacts = { videoId: string; title: string; privacyStatus: string | null; publishAt: string | null; durationSeconds: number | null };

export type LiveStreamEventKind =
  | "settings_saved"
  | "rotation_add"
  | "rotation_remove"
  | "rotation_reorder"
  | "guard_refused"
  | "guard_override"
  | "guard_override_cleared"
  | "sources_set";

export type ProbeResult = MediaProbe;

/** The H.264 encoders the stream can use. Which is the default waits for spike B (plan §6.1): videotoolbox does not pad to CBR. */
export const LIVE_ENCODERS = ["h264_videotoolbox", "libx264"] as const;
export type LiveEncoder = (typeof LIVE_ENCODERS)[number];

/** This computer's live-streams settings (plan §3.12 "Settings → Трансляции"). */
export type LiveStreamsSettings = {
  /** The module switch (§M): off = no timer, no process. Can be on only where streams can be hosted (ADR 0036 §1). */
  enabled: boolean;
  /** Videos kept in the buffer: the one playing and the next ones (owner, msg 2575: 2). */
  bufferDepth: number;
  /** A warning below this much free disk (GB). */
  warnBelowGb: number;
  /** A copy into the buffer is refused if it would leave less than this (GB). */
  refuseBelowGb: number;
  bitrateKbps: number;
  encoder: LiveEncoder;
  /** A bell notice when a stream has not been live for this many minutes. */
  alertMinutes: number;
  /** A folder holding ffmpeg and ffprobe, tried before the usual install folders; `null` = search. */
  ffmpegDir: string | null;
};

export const DEFAULT_LIVE_STREAMS_SETTINGS: LiveStreamsSettings = Object.freeze({
  enabled: false,
  bufferDepth: 2,
  warnBelowGb: 10,
  refuseBelowGb: 5,
  bitrateKbps: 6000,
  encoder: "h264_videotoolbox",
  alertMinutes: 5,
  ffmpegDir: null,
});
