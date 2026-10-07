"use client";

import { useRouter } from "next/navigation";
import { useAppChannel } from "@/components/app-channel";
import { HomeDashboardPanel } from "@/components/home-dashboard-panel";
import { EditorialProfilePanel } from "@/components/editorial-profile-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): this section's own address; its content is unchanged from the
// single dashboard page it was part of.
export default function HomePage() {
  const router = useRouter();
  const { channel } = useAppChannel();
  const t = useT();
  return (
      // `key` forces a clean remount whenever the active channel changes (owner instruction,
      // 2026-09-23: switching channel -- via the topbar dropdown or Settings -- must signal
      // every tab to refresh to the new one). None of these manager components take a
      // `channelId` prop; each resolves "the active channel" itself, once, on its own mount
      // (server-side, via the session's `selectedChannelId`) -- remounting is what makes that
      // mount-time resolution re-run, without changing any of the five components themselves.
      <FeatureErrorBoundary label={t("nav.home")}>
        <div key={channel?.id ?? "no-channel"} className="space-y-6">
          <p className="max-w-3xl text-sm text-zinc-400">{t("page.home.intro")}</p>
          <FeatureErrorBoundary label={`${t("nav.home")} — ${t("page.home.dashboard")}`}>
            <HomeDashboardPanel subscriberCount={channel?.subscriberCount} onViewAllContent={() => router.push("/content")} />
          </FeatureErrorBoundary>
          <div className="max-w-3xl">
            <FeatureErrorBoundary label={`${t("nav.home")} — ${t("conflicts.subject.editorialProfile")}`}>
              <EditorialProfilePanel />
            </FeatureErrorBoundary>
          </div>
        </div>
      </FeatureErrorBoundary>
  );
}
