"use client";

import { useAppChannel } from "@/components/app-channel";
import { ProductionPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function ProductionPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Production">
        <div key={channel?.id ?? "no-channel"}>
          <ProductionPanel activeChannelId={channel?.id ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
