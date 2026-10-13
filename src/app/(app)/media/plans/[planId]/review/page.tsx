"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PlanReviewScreen } from "@/components/plan-review-screen";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";
import { MEDIA_DEFAULT_TAB, MEDIA_TABS } from "@/components/section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md, AC-RT-07): a plan's review screen at its own address, so it can be reloaded,
// bookmarked or opened in another browser tab. `?device=` (and `host=` for its name) = another device's plan (phase 2);
// BL-162 (AC-UX-09): `?wave=` opens it on that wave.
export default function PlanReviewPage() {
  const { planId } = useParams<{ planId: string }>();
  const query = useSearchParams();
  const router = useRouter();
  const t = useT();
  const deviceId = query.get("device");
  return (
    <FeatureErrorBoundary label={t("page.planReview")}>
      <PlanReviewScreen
        planId={planId}
        source={deviceId ? { deviceId, hostname: query.get("host") } : undefined}
        initialWave={query.get("wave")}
        // BL-184 stage 3: back to the kind tab it was opened from (`?from=`), else Media's first tab.
        onClose={() => router.push(`/media/${MEDIA_TABS.find((item) => item.value === query.get("from"))?.value ?? MEDIA_DEFAULT_TAB}`)}
      />
    </FeatureErrorBoundary>
  );
}
