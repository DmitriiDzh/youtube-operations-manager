import type { Translate } from "@/lib/ui-text";
import type { ChannelWorkEntry } from "./channel-work";

// BL-178 part C (docs/roadmap/plans/LOCALIZATION_BASELINE_PLAN.md §3.3 C2, FO-REQ-0022 §6): how a channel's translation alerts
// are shown -- a badge on «Языки» for the active channel, and bell entries for the others (the BL-157 rule, owner msg 2119: the
// active channel has its menu badge). Pure, so the rules are tested on their own; the summary is `GET /api/localization-alerts`.

/** One channel's alert counts, as `GET /api/localization-alerts` returns them. */
export type LanguageAlertChannel = {
  channelId: string;
  missingVideoCount: number;
  missingByLanguage: Record<string, number>;
  deviationCount: number;
};

export const LANGUAGES_HREF = "/languages";

/** "es (3), pt-BR (2)": the languages most often missing first, then by code. Language codes are data, not interface text. */
export function missingLanguagesLabel(byLanguage: Record<string, number>): string {
  return Object.entries(byLanguage)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([language, count]) => `${language} (${count})`)
    .join(", ");
}

/** The «Языки» badge for the active channel: the videos to look at, and what they are made of (shown on hover). */
export function languagesBadge(t: Translate, alert: LanguageAlertChannel | undefined): { badge: number; badgeTitle?: string } {
  if (!alert) return { badge: 0 };
  const badge = alert.missingVideoCount + alert.deviationCount;
  return badge === 0 ? { badge } : { badge, badgeTitle: t("languageAlerts.badgeTitle", { missing: alert.missingVideoCount, deviations: alert.deviationCount }) };
}

/**
 * The bell's entries: per channel that is NOT active, one for the videos without a translation (with the languages) and one for
 * the videos in another language than the channel's. Derived from the current summary, so they go away once the work is done.
 */
export function otherChannelLanguageEntries(t: Translate, channels: readonly LanguageAlertChannel[], activeChannelId: string | null): ChannelWorkEntry[] {
  const entries: ChannelWorkEntry[] = [];
  for (const alert of channels) {
    if (alert.channelId === activeChannelId) continue;
    if (alert.missingVideoCount > 0) {
      entries.push({
        key: `${alert.channelId}:languages:missing`,
        channelId: alert.channelId,
        text: t("languageAlerts.missing", { count: alert.missingVideoCount, languages: missingLanguagesLabel(alert.missingByLanguage) }),
        href: LANGUAGES_HREF,
      });
    }
    if (alert.deviationCount > 0) {
      entries.push({ key: `${alert.channelId}:languages:deviations`, channelId: alert.channelId, text: t("languageAlerts.deviations", { count: alert.deviationCount }), href: LANGUAGES_HREF });
    }
  }
  return entries;
}
