import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import type { ChannelWorkEntry } from "./channel-work";
import { gbLabel } from "./gb-label";

// BL-262 (owner msgs 4541/4542/4545): this computer's own bell notices -- the live streams (BL-176) and the low disk (BL-237) --
// as bell entries with a group icon, an urgency, a short text and the full text on hover, like the other channels' entries. Pure,
// so the rules are tested on their own; the notices are `GET /api/live-streams/notices` and `GET /api/disk-guard/notice`.

/** A bell row; the disk notice belongs to this computer, not to a channel (`channelId: null`). */
export type BellEntry = Omit<ChannelWorkEntry, "channelId"> & { channelId: string | null };

export type LiveNotice = { channelId: string; kind: "live_stream_down" | "live_stream_ended" | "live_stream_source_missing" | "live_segment_switch_failed"; since: number; detail?: string };
export type DiskNotice = { freeBytes: number; thresholdGb: number; since: string };

// Each live-stream notice opens the channel's «Трансляции» tab; the disk notice opens Servers → Sessions where the «Диск» card is.
export const LIVE_STREAM_HREF = "/content/streams";
export const DISK_HREF = "/servers/sessions";

const LIVE_TEXT: Record<LiveNotice["kind"], { short: UiTextKey; detail: UiTextKey }> = {
  live_stream_down: { short: "live.bell.downShort", detail: "live.bell.down" },
  live_stream_ended: { short: "live.bell.endedShort", detail: "live.bell.ended" },
  live_stream_source_missing: { short: "live.bell.sourceMissingShort", detail: "live.bell.sourceMissing" },
  live_segment_switch_failed: { short: "live.bell.segmentSwitchFailedShort", detail: "live.bell.segmentSwitchFailed" },
};

/** One entry per live notice; a missing next video only means the copied ones replay (info), everything else needs the owner. */
export function liveNoticeEntries(t: Translate, notices: readonly LiveNotice[]): ChannelWorkEntry[] {
  return notices.map((notice) => {
    const params = { since: formatDisplayDateTime(new Date(notice.since)), videoId: notice.detail ?? "" };
    return {
      key: `${notice.channelId}-${notice.kind}`,
      channelId: notice.channelId,
      text: t(LIVE_TEXT[notice.kind].short, params),
      detail: t(LIVE_TEXT[notice.kind].detail, params),
      group: "live",
      severity: notice.kind === "live_stream_source_missing" ? "info" : "action",
      href: LIVE_STREAM_HREF,
    };
  });
}

/** The low-disk notice: always an action (the owner has to free space). */
export function diskNoticeEntry(t: Translate, notice: DiskNotice): BellEntry {
  const free = gbLabel(t, notice.freeBytes);
  return {
    key: "disk:low",
    channelId: null,
    text: t("disk.bell.lowShort", { free }),
    detail: t("disk.bell.low", { free, threshold: notice.thresholdGb }),
    group: "disk",
    severity: "action",
    href: DISK_HREF,
  };
}
