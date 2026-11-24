"use client";

import { useT } from "./ui-text-provider";

/** The few fields of a write-log row's detail the owner reads at a glance; anything else stays out of the list. */
export function readWriteLogDetail(detail: string | null): {
  privacyStatus?: string;
  previousPrivacyStatus?: string;
  unchanged?: boolean;
  videoCount?: number;
  failedVideos?: number;
} {
  try {
    const parsed = detail ? (JSON.parse(detail) as Record<string, unknown>) : {};
    return {
      privacyStatus: typeof parsed.privacyStatus === "string" ? parsed.privacyStatus : undefined,
      previousPrivacyStatus: typeof parsed.previousPrivacyStatus === "string" ? parsed.previousPrivacyStatus : undefined,
      unchanged: parsed.changed === false,
      videoCount: Array.isArray(parsed.videoIds) ? parsed.videoIds.length : undefined,
      failedVideos: typeof parsed.failedVideos === "number" && parsed.failedVideos > 0 ? parsed.failedVideos : undefined,
    };
  } catch {
    // A long list is cut in storage and is no longer JSON: show the row without its detail.
    return {};
  }
}

/**
 * What a YouTube write wrote, in one log row: its target and the detail's privacy, video count and failures. Shared by the channel
 * worker log (BL-215) and the Producer's call log (owner TG 4782 review), which store the same description of the same tools.
 */
export function WriteLogDetail({ target, detail }: { target: string | null; detail: string | null }) {
  const t = useT();
  const read = readWriteLogDetail(detail);
  return (
    <>
      {target && <span className="font-mono">{target}</span>}
      {read.privacyStatus &&
        (read.previousPrivacyStatus ? (
          <span>{t("settingsCards.workerActions.privacyChange", { from: read.previousPrivacyStatus, to: read.privacyStatus })}</span>
        ) : (
          <span>{t("settingsCards.workerActions.privacy", { status: read.privacyStatus })}</span>
        ))}
      {read.unchanged && <span className="text-zinc-500">{t("settingsCards.workerActions.unchanged")}</span>}
      {read.videoCount !== undefined && <span>{t("settingsCards.workerActions.videos", { count: String(read.videoCount) })}</span>}
      {read.failedVideos !== undefined && (
        <span className="text-amber-400">{t("settingsCards.workerActions.failedVideos", { count: String(read.failedVideos) })}</span>
      )}
    </>
  );
}
