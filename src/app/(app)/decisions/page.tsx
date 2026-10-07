"use client";

import { useAppChannel } from "@/components/app-channel";
import { DecisionsManager } from "@/components/decisions-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function DecisionsPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Decisions">
        <div className="space-y-6">
          <p className="text-sm text-zinc-400">
            Hypotheses, experiments, and their recorded outcomes &mdash; manual record-keeping
            only. No AI-generated hypotheses and no automatic execution of an approved
            experiment yet (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md).
          </p>
          <DecisionsManager channel={channel ?? null} />
        </div>
      </FeatureErrorBoundary>
  );
}
