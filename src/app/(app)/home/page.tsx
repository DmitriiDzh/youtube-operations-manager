"use client";

import { useRouter } from "next/navigation";
import { useAppChannel } from "@/components/app-channel";
import { HomeDashboardPanel } from "@/components/home-dashboard-panel";
import { ChannelBrandingPanel } from "@/components/channel-branding-panel";
import { ChannelLocalizationsPanel } from "@/components/channel-localizations-panel";
import { EditorialProfilePanel } from "@/components/editorial-profile-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { PublishingSettingsPanel } from "@/components/publishing-settings-panel";
import { ChannelCategoryFixCard } from "@/components/channel-category-fix-card";
import { LocalVideoCleanupCard } from "@/components/local-video-cleanup-card";
import { LOCAL_CLEANUP_ANCHOR, PUBLISHING_SETTINGS_ANCHOR } from "@/components/plan-extras";
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
          {/* BL-223 (CHANNEL_BRANDING_PLAN.md §6, owner msgs 3488/3489): the channel's branding, and its translations below it. */}
          {channel?.id && (
            <div className="max-w-3xl space-y-6">
              <FeatureErrorBoundary label={`${t("nav.home")} — ${t("channelBranding.title")}`}>
                <ChannelBrandingPanel channelId={channel.id} />
              </FeatureErrorBoundary>
              <FeatureErrorBoundary label={`${t("nav.home")} — ${t("channelTranslations.title")}`}>
                <ChannelLocalizationsPanel channelId={channel.id} />
              </FeatureErrorBoundary>
            </div>
          )}
          {/* BL-279 (owner TG 4964: «то что уникально для конкретного канала — лучше настраивать например на странице Главная»): the
              active channel's publishing defaults, the category fix of its uploaded videos and its local copy cleanup, moved here from
              Settings → Channels (BL-266). Each in its own boundary (AGENTS.md §M); the «⋯» links on «План» land on the anchors. */}
          {channel?.id && (
            <section aria-labelledby="channel-settings-title" className="max-w-3xl space-y-3">
              <div>
                <h2 id="channel-settings-title" className="text-lg font-semibold text-zinc-100">{t("channelSettings.title", { channel: channel.title })}</h2>
                <p className="mt-0.5 text-xs text-zinc-400">{t("channelSettings.hint")}</p>
              </div>
              <div id={PUBLISHING_SETTINGS_ANCHOR} className="scroll-mt-20">
                <FeatureErrorBoundary label={`${t("nav.home")} — ${t("publishingSettings.collapsedTitle")}`}>
                  <PublishingSettingsPanel channelId={channel.id} visible collapsible />
                </FeatureErrorBoundary>
              </div>
              <FeatureErrorBoundary label={`${t("nav.home")} — ${t("categoryFix.title")}`}>
                <ChannelCategoryFixCard channelId={channel.id} />
              </FeatureErrorBoundary>
              <div id={LOCAL_CLEANUP_ANCHOR} className="scroll-mt-20">
                <FeatureErrorBoundary label={`${t("nav.home")} — ${t("cleanup.title")}`}>
                  <LocalVideoCleanupCard channelId={channel.id} visible />
                </FeatureErrorBoundary>
              </div>
            </section>
          )}
          <div className="max-w-3xl">
            <FeatureErrorBoundary label={`${t("nav.home")} — ${t("conflicts.subject.editorialProfile")}`}>
              <EditorialProfilePanel />
            </FeatureErrorBoundary>
          </div>
        </div>
      </FeatureErrorBoundary>
  );
}
