"use client";

import { useAppChannel } from "@/components/app-channel";
import { LanguagesManager } from "@/components/languages-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function LanguagesPage() {
  const { channel } = useAppChannel();
  const t = useT();
  return (
      <FeatureErrorBoundary label={t("nav.languages")}>
        <div key={channel?.id ?? "no-channel"}>
          <p className="mb-4 text-sm text-zinc-400">{t("page.languages.intro")}</p>
          <LanguagesManager />
        </div>
      </FeatureErrorBoundary>
  );
}
