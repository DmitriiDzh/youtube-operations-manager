"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { ANALYTICS_SUB_TABS, AnalyticsTab } from "@/components/analytics-tab";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Analytics at `/analytics/<sub-tab>`; the content is unchanged.
export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegment();
  const tab = ANALYTICS_SUB_TABS.find((t) => t.key === segment)?.key;
  return (
    <>
      {tab && (
        <FeatureErrorBoundary label={t("nav.analytics")}>
          <div key={channel?.id ?? "no-channel"}>
            <p className="mb-4 text-sm text-zinc-400">{t("page.analytics.intro")}</p>
            <AnalyticsTab subscriberCount={channel?.subscriberCount} tab={tab} onTabChange={(next) => router.push(`/analytics/${next}`)} />
          </div>
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}
