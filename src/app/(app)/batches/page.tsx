"use client";

import { useAppChannel } from "@/components/app-channel";
import { BatchManager } from "@/components/batch-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function BatchesPage() {
  const { channel } = useAppChannel();
  const t = useT();
  return (
      <FeatureErrorBoundary label={t("nav.batches")}>
        <div>
          <p className="mb-4 text-sm text-zinc-400">{t("page.batches.intro")}</p>
          <BatchManager channelId={channel?.id ?? null} channelTitle={channel?.title ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
