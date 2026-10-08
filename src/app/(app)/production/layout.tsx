"use client";

import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { PRODUCTION_TABS, ProductionPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Production at `/production/<sub-tab>`. The panel lives in this layout, which
// persists while only the sub-tab changes, so its sub-tabs stay mounted and are only hidden, as before.
function planReviewHref(planId: string, source?: { deviceId: string; hostname: string | null }): string {
  const query = new URLSearchParams();
  if (source) {
    query.set("device", source.deviceId);
    if (source.hostname) query.set("host", source.hostname);
  }
  return `/production/plans/${encodeURIComponent(planId)}/review${query.size > 0 ? `?${query.toString()}` : ""}`;
}

export default function ProductionLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segments = useSelectedLayoutSegments();
  const segment = segments[0] ?? null;
  const tab = PRODUCTION_TABS.find((t) => t.value === segment)?.value;
  // An unknown sub-path renders nothing here; its [sub] page answers 404.
  // `/production/plans/<planId>/review` (AC-RT-07): the review screen is shown in place of the panel, which stays mounted
  // and hidden meanwhile (review finding: the selected plan and the other sub-tabs survive opening and closing a review).
  const reviewing = segment === "plans" && segments[2] === "review";
  return (
    <>
      {tab && (
        <FeatureErrorBoundary label={t("nav.production")}>
          <div key={channel?.id ?? "no-channel"} className={reviewing ? "hidden" : undefined}>
            <ProductionPanel
              activeChannelId={channel?.id ?? null}
              tab={tab}
              paused={reviewing}
              onTabChange={(next) => router.push(`/production/${next}`)}
              onReviewPlan={(planId, source) => router.push(planReviewHref(planId, source))}
            />
          </div>
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}
