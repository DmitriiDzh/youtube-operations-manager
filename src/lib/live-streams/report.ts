import { HELPER_STATUS_STALE_MS } from "./notices";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.10/§3.11) -- a stream's state in one vocabulary for every reader: this computer's page,
// the per-device report other computers read (the `live-streams` sync family) and the Operator's status tool. It never
// carries a key, a URL, an ingestion address or error text: states and causes are fixed codes, issues are YouTube's types.
// ---------------------------------------------------------------------------

export const LIVE_STREAM_STATES = ["off", "ended_by_youtube", "starting", "live", "replaying", "no_source", "reconnecting"] as const;
export type LiveStreamState = (typeof LIVE_STREAM_STATES)[number];

export type StreamReportInput = {
  channelId: string;
  intent: "on" | "off";
  onSince: number | null;
  helper: { state: string; updatedAt: number; position: { index: number; videoId: string | null }; lastExit: { at: number; cause: string } | null; missingVideoId: string | null } | null;
  rotationSize: number;
  youtube: { lifeCycleStatus: string | null; streamStatus: string | null; healthStatus: string | null; issueTypes: string[]; viewers: number | null } | null;
  /** The latest of "YouTube ended it" / "encoder started": tells "ended by YouTube" from a plain "off". */
  lastEndOrStart: "youtube_ended" | "encoder_start" | null;
};

export type StreamReportEntry = {
  channelId: string;
  state: LiveStreamState;
  since: string | null;
  playing: { index: number; total: number; videoId: string } | null;
  health: { lifeCycleStatus: string | null; streamStatus: string | null; healthStatus: string | null; issueTypes: string[] } | null;
  lastInterruption: { at: string; cause: string } | null;
  viewers: number | null;
};

const CAUSE = /^[a-z_]{1,40}$/;
const ISSUE = /^[A-Za-z]{1,40}$/;
const YT_WORD = /^[A-Za-z]{1,30}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** §3.10 "States shown": off / ended by YouTube / starting / live / replaying the buffer / no video / reconnecting. */
export function deriveStreamState(input: Pick<StreamReportInput, "intent" | "helper" | "lastEndOrStart">, now: number): LiveStreamState {
  if (input.intent !== "on") return input.lastEndOrStart === "youtube_ended" ? "ended_by_youtube" : "off";
  const helper = input.helper;
  if (!helper || now - helper.updatedAt > HELPER_STATUS_STALE_MS || helper.state === "stopped") return "starting";
  if (helper.state === "replaying") return "replaying";
  if (helper.state === "waiting_for_source") return "no_source";
  if (helper.state === "restarting") return "reconnecting";
  return "live";
}

const word = (value: string | null, pattern: RegExp) => (value !== null && pattern.test(value) ? value : null);

/** One stream's entry for the page, the per-device report and the Operator. Anything not matching its fixed shape is dropped. */
export function streamReportEntry(input: StreamReportInput, now: number): StreamReportEntry {
  const state = deriveStreamState(input, now);
  const on = input.intent === "on";
  const videoId = input.helper?.position.videoId ?? null;
  const exit = input.helper?.lastExit ?? null;
  return {
    channelId: input.channelId,
    state,
    since: on && input.onSince !== null ? new Date(input.onSince).toISOString() : null,
    playing:
      on && input.helper && videoId && VIDEO_ID.test(videoId) && (state === "live" || state === "replaying")
        ? { index: input.helper.position.index, total: input.rotationSize, videoId }
        : null,
    health:
      on && input.youtube
        ? {
            lifeCycleStatus: word(input.youtube.lifeCycleStatus, YT_WORD),
            streamStatus: word(input.youtube.streamStatus, YT_WORD),
            healthStatus: word(input.youtube.healthStatus, YT_WORD),
            issueTypes: input.youtube.issueTypes.filter((t) => ISSUE.test(t)).slice(0, 20),
          }
        : null,
    lastInterruption: exit && CAUSE.test(exit.cause) ? { at: new Date(exit.at).toISOString(), cause: exit.cause } : null,
    viewers: on && input.youtube && typeof input.youtube.viewers === "number" && Number.isFinite(input.youtube.viewers) ? Math.max(0, Math.floor(input.youtube.viewers)) : null,
  };
}
