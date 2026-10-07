"use client";

import { useAppChannel } from "@/components/app-channel";
import { LanguagesManager } from "@/components/languages-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function LanguagesPage() {
  const { channel } = useAppChannel();
  return (
      <FeatureErrorBoundary label="Languages">
        <div key={channel?.id ?? "no-channel"}>
          <p className="mb-4 text-sm text-zinc-400">
            Generating with AI is the primary way to add a language &mdash; review and edit
            the agent&rsquo;s proposals before creating a Change Set. Importing an edited XLSX
            workbook remains available as a secondary, bulk action. No metadata is written to
            YouTube anywhere in this tab &mdash; approval here is a local decision only, and
            &ldquo;Approved&rdquo; never means a real YouTube write happened.
          </p>
          <LanguagesManager />
        </div>
      </FeatureErrorBoundary>
  );
}
