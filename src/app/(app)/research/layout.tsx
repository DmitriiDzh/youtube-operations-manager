"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { RESEARCH_TABS, ResearchTab } from "@/components/research-tab";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Research at `/research/<sub-tab>`. Plain `/research` lets the first summary
// pick Inbox or Channels (AC-R1-2) and replaces the address with it. Sub-tabs stay mounted and hidden (AC-R1-1).
export default function ResearchLayout({ children }: { children: ReactNode }) {
  const { setResearchPending } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegment();
  const tab = RESEARCH_TABS.find((t) => t.value === segment)?.value ?? null;
  return (
    <>
      <FeatureErrorBoundary label={t("nav.research")}>
        <ResearchTab
          onPendingChange={setResearchPending}
          tab={tab}
          onTabChange={(next, options) => (options.replace ? router.replace(`/research/${next}`) : router.push(`/research/${next}`))}
        />
      </FeatureErrorBoundary>
      {children}
    </>
  );
}
