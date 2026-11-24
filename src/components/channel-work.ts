import type { PlanChannelWork, PlanDeviceRef } from "@/lib/generation-plans/contracts";
import type { Translate } from "@/lib/ui-text";

// BL-157 (docs/roadmap/plans/SERVERS_MEDIA_PLAN.md §D, FO-REQ-0009 §3/§3a): how the other channels' open Media work is shown --
// a count next to each channel in the switcher, and one bell entry per channel and type of work. Pure (no React), so the
// rules are tested on their own; the summary they read is `GET /api/generation-plans/summary` (`channels`).

/**
 * A plan's review screen (BL-149 AC-RT-07); `device` = another device's plan (its report names it); BL-162 (AC-UX-09): `wave`
 * opens it on that wave.
 */
export function planReviewHref(planId: string, device?: PlanDeviceRef, wave?: string): string {
  const query = new URLSearchParams();
  if (device) {
    query.set("device", device.deviceId);
    if (device.hostname) query.set("host", device.hostname);
  }
  if (wave) query.set("wave", wave);
  return `/media/plans/${encodeURIComponent(planId)}/review${query.size > 0 ? `?${query.toString()}` : ""}`;
}

/** AC-BL-03: the switcher's line for a channel with tracks waiting ("5 waiting (3 passed, 2 rejected)"); null = nothing waits. */
export function waitingLabel(t: Translate, work: Pick<PlanChannelWork, "waitingReview" | "waitingPassed" | "waitingRejected"> | undefined): string | null {
  if (!work || work.waitingReview === 0) return null;
  return work.waitingRejected > 0
    ? t("channelWork.waitingSplit", { count: work.waitingReview, passed: work.waitingPassed, rejected: work.waitingRejected })
    : t("channelWork.waiting", { count: work.waitingReview });
}

/** BL-262 (owner msgs 4541/4542/4545): what a bell entry is about -- the bell shows it as an icon instead of a group header. */
export type BellGroup = "disk" | "media" | "translations" | "storyboards" | "packages" | "publishing" | "live" | "sync";

/** BL-262: `action` = the owner has to act (red icon); `info` = something to know or look at (sky icon). */
export type BellSeverity = "action" | "info";

export type ChannelWorkEntry = {
  /** Stable per channel and type of work, so an entry updates in place as its count changes. */
  key: string;
  channelId: string;
  /** BL-262: the short text (2-4 words) shown in the row. */
  text: string;
  /** BL-262: the full text (counts split, data age, thresholds), shown on hover. */
  detail: string;
  group: BellGroup;
  severity: BellSeverity;
  /** Where the entry's button leads once the channel is active. */
  href: string;
};

/**
 * AC-BL-04/06 (owner msg 2119): the bell's entries -- only channels that are NOT active (the active one has its own menu
 * badge). Per channel: one review entry (the waiting count, its passed/rejected split and each wave's count), then one
 * entry per plan and notice kind. Entries are derived from the current summary, so they go away when the work is done.
 */
export function otherChannelEntries(t: Translate, channels: readonly PlanChannelWork[], activeChannelId: string | null): ChannelWorkEntry[] {
  const entries: ChannelWorkEntry[] = [];
  for (const work of channels) {
    if (work.channelId === activeChannelId) continue;
    if (work.waitingReview > 0) {
      const waves = work.batches.filter((b) => b.groupId !== null).map((b) => t("channelWork.wave", { wave: b.title, count: b.waiting }));
      const counts =
        work.waitingRejected > 0
          ? t("channelWork.reviewSplit", { count: work.waitingReview, passed: work.waitingPassed, rejected: work.waitingRejected })
          : t("channelWork.review", { count: work.waitingReview });
      const short = t("channelWork.reviewShort", { count: work.waitingReview });
      const withWaves = (text: string) => (waves.length > 0 ? `${text} · ${waves.join(" · ")}` : text);
      const only = work.plans.length === 1 ? work.plans[0] : null;
      entries.push({
        key: `${work.channelId}:review`,
        channelId: work.channelId,
        text: withWaves(short),
        detail: withWaves(counts),
        group: "media",
        severity: "info",
        href: only ? planReviewHref(only.planId, only.device) : "/media/plans",
      });
    }
    // One entry per plan and notice kind (AC-BL-04). Owner msg 4535 (2026-11-16): «этап плана завершён» / «план выполнен»
    // are not shown in the bell -- it holds only what waits for the owner; the plan card still shows them.
    for (const { planId, planTitle, device, notice } of work.notices) {
      if (notice.kind === "stage_complete" || notice.kind === "plan_complete") continue;
      const plan = planTitle || planId;
      const planKey = `${device?.deviceId ?? "here"}:${planId}`;
      const [text, detail] =
        notice.kind === "attempts_exhausted"
          ? [t("channelWork.attemptsExhaustedShort", { plan, count: notice.count }), t("channelWork.attemptsExhausted", { plan, count: notice.count })]
          : notice.kind === "budget_100"
            ? [t("channelWork.budget100Short", { plan }), t("channelWork.budget100", { plan })]
            : [t("channelWork.budget80Short", { plan }), t("channelWork.budget80", { plan })];
      // BL-262: an exhausted attempt count or budget stops the plan -- the owner has to act; 80% of the budget is a heads-up.
      const severity: BellSeverity = notice.kind === "budget_80" ? "info" : "action";
      // BL-184 stage 3 (independent review): to the plan itself -- Media's kind tabs could hide it under the first tab.
      entries.push({ key: `${work.channelId}:${planKey}:${notice.kind}`, channelId: work.channelId, text, detail, group: "media", severity, href: planReviewHref(planId, device ?? undefined) });
    }
  }
  return entries;
}
