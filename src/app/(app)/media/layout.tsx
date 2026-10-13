"use client";

import { useRouter, useSearchParams, useSelectedLayoutSegments } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { MEDIA_TABS, MediaPanel } from "@/components/production-panel";
import { MEDIA_DEFAULT_TAB } from "@/components/section-tabs";
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
  const query = useSearchParams();
  const segment = segments[0] ?? null;
  // `/media/plans/<planId>/review` (AC-RT-07): the review screen is shown in place of the panel, which stays mounted and
  // hidden meanwhile (review finding: the selected plan and the other sub-tab survive opening and closing a review).
  // BL-184: `/media/storyboards/<storyboardId>` -- a storyboard's review screen, shown the same way.
  const reviewingPlan = segment === "plans" && segments[2] === "review";
  const reviewing = reviewingPlan || (segment === "storyboards" && segments.length > 1);
  // BL-184 stage 3: a plan is reviewed from a kind tab (`?from=`); the panel behind the review stays on that tab.
  const from = MEDIA_TABS.find((item) => item.value === query.get("from"))?.value;
  // An unknown sub-path renders nothing here; its [sub] page answers 404.
  const tab = MEDIA_TABS.find((item) => item.value === segment)?.value ?? (reviewingPlan ? (from ?? MEDIA_DEFAULT_TAB) : undefined);
  // AC-SM-04 (review round 1): a review open when the channel changes was the other channel's plan -- back to Plans. A bell
  // entry that switches and opens a review navigates after this (the parent layout's effect runs later), so it still lands.
  const channelId = channel?.id ?? null;
  const shownChannel = useRef(channelId);
  useEffect(() => {
    const before = shownChannel.current;
    shownChannel.current = channelId;
    if (before !== null && channelId !== null && before !== channelId && reviewing) router.replace(segment === "storyboards" ? "/media/storyboards" : `/media/${tab ?? MEDIA_DEFAULT_TAB}`);
  }, [channelId, reviewing, router, segment, tab]);
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
              onReviewPlan={(planId, source, wave) => router.push(withFrom(planReviewHref(planId, source, wave), tab))}
              onOpenStoryboard={(storyboardId, view) => router.push(`/media/storyboards/${encodeURIComponent(storyboardId)}${view ? `?view=${view}` : ""}`)}
            />
          </div>
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}

/** BL-184 stage 3: the kind tab a plan review was opened from, so closing it returns there. */
function withFrom(href: string, tab: string | undefined): string {
  if (!tab) return href;
  return `${href}${href.includes("?") ? "&" : "?"}from=${encodeURIComponent(tab)}`;
}
