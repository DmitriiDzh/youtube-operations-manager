"use client";

import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { MEDIA_TABS, MediaPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): a section at `/<section>/<sub-tab>`; the panel lives in this layout, which
// persists while only the sub-tab changes, so its sub-tabs stay mounted and are only hidden. BL-157 (SERVERS_MEDIA_PLAN.md
// AC-SM-01/04): Media is the active channel's -- it remounts when the channel changes.
function planReviewHref(planId: string, source?: { deviceId: string; hostname: string | null }): string {
  const query = new URLSearchParams();
  if (source) {
    query.set("device", source.deviceId);
    if (source.hostname) query.set("host", source.hostname);
  }
  return `/media/plans/${encodeURIComponent(planId)}/review${query.size > 0 ? `?${query.toString()}` : ""}`;
}

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
