"use client";

import { useAppChannel } from "@/components/app-channel";
import { DeviceHandoffPanel } from "@/components/device-handoff-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function MergePage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Merge">
        <div className="max-w-3xl">
          <p className="mb-4 text-sm text-zinc-400">
            Handoff data (Batches history, audit, Research, Decisions) now syncs automatically while
            the app runs (Settings &rarr; Sync; the bell in the header shows its state and asks you
            if both computers changed data). The manual export/import below remains as a fallback.
            Change drafts (Change Sets/AI proposals) are different: they now sync continuously in
            the background between devices sharing the same Syncthing folder, and any conflicting
            concurrent edit is listed here for you to review &mdash; nothing is ever silently
            resolved by picking one side. Syncthing only ever carries files &mdash; it is never
            treated as a database, and no OAuth token or AI connection credential ever leaves
            this device.
          </p>
          <DeviceHandoffPanel channelId={channel?.id ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
