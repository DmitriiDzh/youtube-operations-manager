"use client";

import { notFound, useRouter, useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { PRODUCTION_TABS, ProductionPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

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
  const segments = useSelectedLayoutSegments();
  const segment = segments[0] ?? null;
  const tab = PRODUCTION_TABS.find((t) => t.value === segment)?.value;
  // `/production` itself redirects (page.tsx); any other unknown sub-path is not a page.
  if (segment !== null && !tab) notFound();
  // `/production/plans/<planId>/review` (AC-RT-07): the review screen replaces the panel, as it did inside Plans.
  const reviewing = segment === "plans" && segments[2] === "review";
  return (
    <>
      {tab && !reviewing && (
        <FeatureErrorBoundary label="Production">
          <div key={channel?.id ?? "no-channel"}>
            <ProductionPanel
              activeChannelId={channel?.id ?? null}
              tab={tab}
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
