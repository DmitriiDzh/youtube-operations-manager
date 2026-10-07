"use client";

import { useAppChannel } from "@/components/app-channel";
import { AnalyticsTab } from "@/components/analytics-tab";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function AnalyticsPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Analytics">
        <div key={channel?.id ?? "no-channel"}>
          <p className="mb-4 text-sm text-zinc-400">
            Overview numbers come from the data this app collects and stores (daily automatic
            collection or &ldquo;Collect now&rdquo;); &ldquo;Refresh live&rdquo; reads them from
            YouTube directly. Percentages are computed facts (period-over-period deltas from real
            numbers, same as Studio&apos;s own cards) &mdash; AI-generated recommendations remain
            Phase 10&apos;s own, separate scope.
          </p>
          <AnalyticsTab subscriberCount={channel?.subscriberCount} />
        </div>
      </FeatureErrorBoundary>
  );
}
