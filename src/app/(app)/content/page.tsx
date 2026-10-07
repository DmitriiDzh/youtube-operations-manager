"use client";

import { useAppChannel } from "@/components/app-channel";
import { ContentManager } from "@/components/content-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function ContentPage() {
  const { channel } = useAppChannel();
  const t = useT();
  return (
      <FeatureErrorBoundary label={t("nav.content")}>
        <div key={channel?.id ?? "no-channel"}>
          <p className="mb-4 text-sm text-zinc-400">{t("page.content.intro")}</p>
          <ContentManager />
        </div>
      </FeatureErrorBoundary>
  );
}
