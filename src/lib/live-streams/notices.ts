// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.10 "Bell notices", §4.1 "Alert") -- what the bell says about this computer's streams.
// Pure: the caller passes each stream's intent, the helper's status, YouTube's last poll and the latest end event.
// ---------------------------------------------------------------------------

export type LiveNoticeKind = "live_stream_down" | "live_stream_ended" | "live_stream_source_missing" | "live_segment_switch_failed";
export type LiveNotice = { channelId: string; kind: LiveNoticeKind; since: number; detail?: string };

export type StreamNoticeInput = {
  channelId: string;
  intent: "on" | "off";
  onSince: number | null;
  /** The helper's status file, if any. */
  helper: { state: string; updatedAt: number; lastExitAt: number | null; missingVideoId: string | null } | null;
  /** YouTube's last poll of the broadcast (§3.10), if any. */
  youtube: { checkedAt: number; lifeCycleStatus: string | null; notLiveSince: number | null } | null;
  /** The latest `youtube_ended` event, if any. */
  endedAt: number | null;
  /** BL-205: the latest failed segment switch not followed by a successful one, if any. */
  segmentSwitchFailedAt?: number | null;
};

/** A helper status older than this means the helper is gone (it writes every 5 s while running). */
export const HELPER_STATUS_STALE_MS = 2 * 60_000;
/** How long the bell keeps saying YouTube ended a broadcast. */
export const ENDED_NOTICE_MS = 24 * 3_600_000;

/** Since when the encoder has not been sending, `null` when it is sending (replaying the buffer counts as sending). */
export function encoderDownSince(input: StreamNoticeInput, now: number): number | null {
  if (input.intent !== "on") return null;
  const helper = input.helper;
  if (!helper) return input.onSince ?? now;
  if (now - helper.updatedAt > HELPER_STATUS_STALE_MS) return helper.updatedAt;
  if (helper.state === "running" || helper.state === "replaying") return null;
  return helper.lastExitAt ?? helper.updatedAt;
}

/** §3.10: down = the encoder or YouTube has not been live for at least the alert delay (§4.1: 5 min -> a notice at 5:00). */
export function liveNotices(streams: readonly StreamNoticeInput[], now: number, alertMinutes: number): LiveNotice[] {
  const notices: LiveNotice[] = [];
  const delay = alertMinutes * 60_000;
  for (const s of streams) {
    if (s.intent === "on") {
      const encoderDown = encoderDownSince(s, now);
      const youtubeDown = s.youtube?.notLiveSince ?? null;
      const downs = [encoderDown, youtubeDown].filter((v): v is number => v !== null);
      const since = downs.length > 0 ? Math.min(...downs) : null;
      if (since !== null && now - since >= delay) notices.push({ channelId: s.channelId, kind: "live_stream_down", since });
      if (s.helper?.missingVideoId) notices.push({ channelId: s.channelId, kind: "live_stream_source_missing", since: s.helper.updatedAt, detail: s.helper.missingVideoId });
      // BL-205: a failed segment switch is shown for 24 h, or until a later switch succeeds.
      if (s.segmentSwitchFailedAt && now - s.segmentSwitchFailedAt < ENDED_NOTICE_MS) notices.push({ channelId: s.channelId, kind: "live_segment_switch_failed", since: s.segmentSwitchFailedAt });
    } else if (s.endedAt !== null && now - s.endedAt < ENDED_NOTICE_MS) {
      notices.push({ channelId: s.channelId, kind: "live_stream_ended", since: s.endedAt });
    }
  }
  return notices;
}
