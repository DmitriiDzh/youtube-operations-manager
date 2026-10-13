import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate } from "@/lib/ui-text";
import type { ChannelWorkEntry } from "./channel-work";

// BL-182 stage 1 (FO-REQ-0023 §4 D; PUBLISHING_PLAN.md §2 stage 1 item 3): the "nothing scheduled within 7 days" reminder -- a
// badge on «Контент» for the active channel and bell entries for the others (the BL-157 rule, as the translation alerts). Pure, so
// the rules are tested on their own; the summary is `GET /api/publishing-alerts`.

export type PublishingAlertChannel = {
  channelId: string;
  lastSyncedAt: string | null;
  coveredThrough: string | null;
  scheduledCount: number;
  unscheduledCount: number;
  daysCovered: number;
  due: boolean;
  thresholdDays: number;
};

export const CALENDAR_HREF = "/content/calendar";

function coverageText(t: Translate, alert: PublishingAlertChannel): string {
  // Date and time (review): "data from 13.10.2026" would hide an 18-hour-old copy.
  const age = alert.lastSyncedAt ? formatDisplayDateTime(alert.lastSyncedAt) : "—";
  return alert.coveredThrough
    ? t("publishingAlerts.coveredThrough", { date: formatDisplayDate(alert.coveredThrough), days: alert.daysCovered, age })
    : t("publishingAlerts.nothingScheduled", { age });
}

/** The «Контент» badge: how many days are missing to cover the threshold (at least 1), with the coverage on hover. */
export function contentBadge(t: Translate, alert: PublishingAlertChannel | undefined): { badge: number; badgeTitle?: string } {
  if (!alert || !alert.due) return { badge: 0 };
  return { badge: Math.max(1, alert.thresholdDays - alert.daysCovered), badgeTitle: coverageText(t, alert) };
}

/** The bell's entries for every channel that is NOT active and whose coverage ends within the threshold. */
export function otherChannelPublishingEntries(t: Translate, channels: readonly PublishingAlertChannel[], activeChannelId: string | null): ChannelWorkEntry[] {
  return channels
    .filter((alert) => alert.channelId !== activeChannelId && alert.due)
    .map((alert) => ({ key: `${alert.channelId}:publishing:coverage`, channelId: alert.channelId, text: coverageText(t, alert), href: CALENDAR_HREF }));
}
