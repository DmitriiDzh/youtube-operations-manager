"use client";

import { useAppChannel } from "@/components/app-channel";
import { ContentManager } from "@/components/content-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function ContentPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Content">
        <div key={channel?.id ?? "no-channel"}>
          <p className="mb-4 text-sm text-zinc-400">
            Your synchronized videos, Studio-style. Read-only: no metadata is written to
            YouTube from this tab.
          </p>
          <ContentManager />
        </div>
      </FeatureErrorBoundary>
  );
}
