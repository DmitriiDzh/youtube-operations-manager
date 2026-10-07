"use client";

import { useAppChannel } from "@/components/app-channel";
import { BatchManager } from "@/components/batch-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function BatchesPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Batches">
        <div>
          <p className="mb-4 text-sm text-zinc-400">
            Select approved changes into a Batch and preview it in dry-run mode. A real,
            non-dry-run write is only possible when &ldquo;Live writes&rdquo; is turned on
            in Settings &mdash; off by default every session.
          </p>
          <BatchManager channelId={channel?.id ?? null} channelTitle={channel?.title ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
