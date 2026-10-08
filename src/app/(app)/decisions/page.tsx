"use client";

import { useAppChannel } from "@/components/app-channel";
import { DecisionsManager } from "@/components/decisions-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function DecisionsPage() {
  const { channel } = useAppChannel();
  const t = useT();
  return (
      <FeatureErrorBoundary label={t("nav.decisions")}>
        <div className="space-y-6">
          <p className="text-sm text-zinc-400">{t("page.decisions.intro")}</p>
          <DecisionsManager channel={channel ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
