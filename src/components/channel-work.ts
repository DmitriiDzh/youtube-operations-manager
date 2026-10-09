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

export type ChannelWorkEntry = {
  /** Stable per channel and type of work, so an entry updates in place as its count changes. */
  key: string;
  channelId: string;
  text: string;
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
      const only = work.plans.length === 1 ? work.plans[0] : null;
      entries.push({
        key: `${work.channelId}:review`,
        channelId: work.channelId,
        text: waves.length > 0 ? `${counts} · ${waves.join(" · ")}` : counts,
        href: only ? planReviewHref(only.planId, only.device) : "/media/plans",
      });
    }
    // One entry per plan and notice kind (AC-BL-04): a plan's completed stages are one entry naming them all.
    const stagesDone = new Map<string, string[]>();
    for (const { planId, device, notice } of work.notices) {
      if (notice.kind !== "stage_complete") continue;
      const key = `${device?.deviceId ?? "here"}:${planId}`;
      stagesDone.set(key, [...(stagesDone.get(key) ?? []), notice.title]);
    }
    const listed = new Set<string>();
    for (const { planId, planTitle, device, notice } of work.notices) {
      const plan = planTitle || planId;
      const planKey = `${device?.deviceId ?? "here"}:${planId}`;
      if (notice.kind === "stage_complete") {
        if (listed.has(planKey)) continue;
        listed.add(planKey);
      }
      const text =
        notice.kind === "stage_complete"
          ? t("channelWork.stageComplete", { plan, stage: (stagesDone.get(planKey) ?? [notice.title]).join(", ") })
          : notice.kind === "plan_complete"
            ? t("channelWork.planComplete", { plan })
            : notice.kind === "attempts_exhausted"
              ? t("channelWork.attemptsExhausted", { plan, count: notice.count })
              : notice.kind === "budget_100"
                ? t("channelWork.budget100", { plan })
                : t("channelWork.budget80", { plan });
      entries.push({ key: `${work.channelId}:${planKey}:${notice.kind}`, channelId: work.channelId, text, href: "/media/plans" });
    }
  }
  return entries;
}
