"use client";

import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { MEDIA_TABS, MediaPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";
import { planReviewHref } from "@/components/channel-work";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): a section at `/<section>/<sub-tab>`; the panel lives in this layout, which
// persists while only the sub-tab changes, so its sub-tabs stay mounted and are only hidden. BL-157 (SERVERS_MEDIA_PLAN.md
// AC-SM-01/04): Media is the active channel's -- it remounts when the channel changes.
export default function MediaLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segments = useSelectedLayoutSegments();
  const segment = segments[0] ?? null;
  const tab = MEDIA_TABS.find((item) => item.value === segment)?.value;
  // An unknown sub-path renders nothing here; its [sub] page answers 404.
  // `/media/plans/<planId>/review` (AC-RT-07): the review screen is shown in place of the panel, which stays mounted and
  // hidden meanwhile (review finding: the selected plan and the other sub-tab survive opening and closing a review).
  const reviewing = segment === "plans" && segments[2] === "review";
  // AC-SM-04 (review round 1): a review open when the channel changes was the other channel's plan -- back to Plans. A bell
  // entry that switches and opens a review navigates after this (the parent layout's effect runs later), so it still lands.
  const channelId = channel?.id ?? null;
  const shownChannel = useRef(channelId);
  useEffect(() => {
    const before = shownChannel.current;
    shownChannel.current = channelId;
    if (before !== null && channelId !== null && before !== channelId && reviewing) router.replace("/media/plans");
  }, [channelId, reviewing, router]);
  return (
    <>
      {tab && (
        <FeatureErrorBoundary label={t("nav.media")}>
          <div key={channel?.id ?? "no-channel"} className={reviewing ? "hidden" : undefined}>
            <MediaPanel
              activeChannelId={channel?.id ?? null}
              tab={tab}
              paused={reviewing}
              onTabChange={(next) => router.push(`/media/${next}`)}
              onReviewPlan={(planId, source) => router.push(planReviewHref(planId, source))}
            />
          </div>
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}
