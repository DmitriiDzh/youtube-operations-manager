"use client";

import { notFound, useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { ANALYTICS_SUB_TABS, AnalyticsTab } from "@/components/analytics-tab";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Analytics at `/analytics/<sub-tab>`; the content is unchanged.
export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const segment = useSelectedLayoutSegment();
  const tab = ANALYTICS_SUB_TABS.find((t) => t.key === segment)?.key;
  if (segment !== null && !tab) notFound();
  return (
    <>
      {tab && (
        <FeatureErrorBoundary label="Analytics">
          <div key={channel?.id ?? "no-channel"}>
            <p className="mb-4 text-sm text-zinc-400">
              Overview numbers come from the data this app collects and stores (daily automatic
              collection or &ldquo;Collect now&rdquo;); &ldquo;Refresh live&rdquo; reads them from
              YouTube directly. Percentages are computed facts (period-over-period deltas from real
              numbers, same as Studio&apos;s own cards) &mdash; AI-generated recommendations remain
              Phase 10&apos;s own, separate scope.
            </p>
            <AnalyticsTab subscriberCount={channel?.subscriberCount} tab={tab} onTabChange={(next) => router.push(`/analytics/${next}`)} />
          </div>
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}
