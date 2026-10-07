"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PlanReviewScreen } from "@/components/plan-review-screen";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md, AC-RT-07): a plan's review screen at its own address, so it can be reloaded,
// bookmarked or opened in another browser tab. `?device=` (and `host=` for its name) = another device's plan (phase 2).
export default function PlanReviewPage() {
  const { planId } = useParams<{ planId: string }>();
  const query = useSearchParams();
  const router = useRouter();
  const deviceId = query.get("device");
  return (
    <FeatureErrorBoundary label="Plan review">
      <PlanReviewScreen
        planId={planId}
        source={deviceId ? { deviceId, hostname: query.get("host") } : undefined}
        onClose={() => router.push("/production/plans")}
      />
    </FeatureErrorBoundary>
  );
}
