import type { Translate } from "@/lib/ui-text";
import type { ChannelWorkEntry } from "./channel-work";

// BL-184 stage 1 (FO-REQ-0024 §4 D): storyboards waiting for the owner -- counted on the Media badge for the active channel, a bell
// entry for each other channel (the BL-157 rule, as the plans and the publishing reminder). Pure; the summary is
// `GET /api/storyboard-alerts`.

export type StoryboardAlertChannel = { channelId: string; waiting: number; storyboardId: string | null };

export const STORYBOARDS_HREF = "/media/storyboards";

const hrefOf = (alert: StoryboardAlertChannel) => (alert.storyboardId ? `${STORYBOARDS_HREF}/${encodeURIComponent(alert.storyboardId)}` : STORYBOARDS_HREF);

/** How many of the active channel's storyboards wait for the owner (added to the Media badge). */
export function activeStoryboardsWaiting(channels: readonly StoryboardAlertChannel[], activeChannelId: string | null): number {
  return channels.find((alert) => alert.channelId === activeChannelId)?.waiting ?? 0;
}

/** The bell's entries for every channel that is NOT active with storyboards waiting; one waiting storyboard opens directly. */
export function otherChannelStoryboardEntries(t: Translate, channels: readonly StoryboardAlertChannel[], activeChannelId: string | null): ChannelWorkEntry[] {
  return channels
    .filter((alert) => alert.channelId !== activeChannelId && alert.waiting > 0)
    .map((alert) => ({ key: `${alert.channelId}:storyboards:waiting`, channelId: alert.channelId, text: t("storyboards.alert.waiting", { count: alert.waiting }), href: hrefOf(alert) }));
}

/**
 * The Media badge's hover text: the plans' split (as before) and, when storyboards wait too, their count -- so a badge of 3 says
 * what the 3 are. Undefined when the plain number says it all.
 */
export function mediaBadgeTitle(t: Translate, plansWaiting: number, plansRejected: number, storyboardsWaiting: number): string | undefined {
  const plans = plansRejected > 0 ? t("plans.badgeSplit", { passed: plansWaiting - plansRejected, rejected: plansRejected }) : null;
  if (storyboardsWaiting === 0) return plans ?? undefined;
  return [plans ?? (plansWaiting > 0 ? t("storyboards.alert.plans", { count: plansWaiting }) : null), t("storyboards.alert.waiting", { count: storyboardsWaiting })].filter(Boolean).join(" · ");
}
