import type { Translate } from "@/lib/ui-text";
import type { ChannelWorkEntry } from "./channel-work";

// Fix of BL-257 (ADR 0070; owner report 2026-11-24: WWE V31/V32 waited for review and neither the Media menu nor the bell said so):
// the final videos waiting for the owner -- counted on the Media menu badge for the active channel, a bell entry for each other
// channel (the BL-157 rule, as the storyboards and the plans). Pure; the summary is `GET /api/package-review-alerts`.

export type PackageReviewAlertChannel = { channelId: string; waiting: number };

/** Media → «Видео на проверку». The panel is not told which package to open (it opens every waiting one by itself). */
export const PACKAGE_REVIEWS_HREF = "/media/packages";

/** How many of the active channel's final videos wait for the owner (added to the Media badge). */
export function activePackagesWaiting(channels: readonly PackageReviewAlertChannel[], activeChannelId: string | null): number {
  return channels.find((alert) => alert.channelId === activeChannelId)?.waiting ?? 0;
}

/** The bell's entries for every channel that is NOT active with final videos waiting for review. */
export function otherChannelPackageEntries(t: Translate, channels: readonly PackageReviewAlertChannel[], activeChannelId: string | null): ChannelWorkEntry[] {
  return channels
    .filter((alert) => alert.channelId !== activeChannelId && alert.waiting > 0)
    .map((alert) => ({
      key: `${alert.channelId}:packages:waiting`,
      channelId: alert.channelId,
      text: t("channelWork.packagesWaitingShort", { count: alert.waiting }),
      detail: t("channelWork.packagesWaiting", { count: alert.waiting }),
      group: "packages" as const,
      severity: "info" as const,
      href: PACKAGE_REVIEWS_HREF,
    }));
}
