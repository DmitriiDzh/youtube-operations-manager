"use client";

import { useAppChannel } from "@/components/app-channel";
import { ResearchTab } from "@/components/research-tab";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function ResearchPage() {
  const { setResearchPending } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Research">
        <ResearchTab onPendingChange={setResearchPending} />
      </FeatureErrorBoundary>
  );
}
