"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { ContentManager } from "@/components/content-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { LiveStreamPanel } from "@/components/live-stream-panel";
import { PublishingCalendar } from "@/components/publishing-calendar";
import { PublishingPackages } from "@/components/publishing-packages";
import { PublishingSettingsPanel } from "@/components/publishing-settings-panel";
import { VideoProjectsPanel } from "@/components/video-projects-panel";
import { CONTENT_TABS } from "@/components/section-tabs";
import { useContentTabBadges } from "@/components/content-tab-badges";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the section's own address. BL-176 (LIVE_STREAMS_PLAN.md §3.12): Content has
// two sub-tabs -- «Видео» (the list it always was) and «Трансляции» (the active channel's live stream). BL-182 adds «Календарь» and «Публикация». Both stay mounted once
// shown and are only hidden, like the other sections' sub-tabs; both remount when the channel changes.
export default function ContentLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegment();
  // BL-221 (CONTENT_UX_PLAN.md stage E): what each tab is waiting for, on the tab itself.
  const badges = useContentTabBadges(channel?.id ?? null);
  const tab = CONTENT_TABS.find((item) => item.value === segment)?.value ?? null;
  if (!tab) return <>{children}</>;
  return (
    <>
      <div className="mb-4 inline-flex gap-1 rounded-lg bg-zinc-950 p-1" role="tablist">
        {CONTENT_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={tab === item.value}
            onClick={() => router.push(`/content/${item.value}`)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${tab === item.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {t(item.labelKey)}
            {item.value === "publishing" && badges.releases > 0 && (
              <span className="ml-1.5 rounded-full bg-violet-600/80 px-1.5 text-[10px] font-semibold text-white" title={t("contentTabs.badge.releases", { count: badges.releases })}>
                {badges.releases}
              </span>
            )}
            {item.value === "calendar" && badges.calendarDue && (
              <span className="ml-1.5 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-zinc-950" title={t("contentTabs.badge.calendar")}>
                !
              </span>
            )}
            {item.value === "streams" && badges.streamTrouble && (
              <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" title={t("contentTabs.badge.stream")} role="img" aria-label={t("contentTabs.badge.stream")} />
            )}
          </button>
        ))}
      </div>
      <div key={channel?.id ?? "no-channel"}>
        <div className={tab === "videos" ? undefined : "hidden"}>
          <FeatureErrorBoundary label={t("nav.content")}>
            <p className="mb-4 text-sm text-zinc-400">{t("page.content.intro")}</p>
            <ContentManager />
          </FeatureErrorBoundary>
        </div>
        <div className={tab === "publishing" ? undefined : "hidden"}>
          <FeatureErrorBoundary label={t("tabs.content.publishing")}>
            <div className="space-y-4">
              {/* BL-194 (ADR 0040): the videos in work come first; their own boundary keeps Publishing working if they fail (§M). */}
              <FeatureErrorBoundary label={t("videoProjects.title")}>
                <VideoProjectsPanel channelId={channel?.id ?? null} visible={tab === "publishing"} />
              </FeatureErrorBoundary>
              <PublishingPackages channelId={channel?.id ?? null} visible={tab === "publishing"} />
              {/* BL-221: the channel's publishing defaults are set rarely -- folded under the board and the packages. */}
              <details className="group rounded-xl border border-zinc-800 bg-zinc-900">
                <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-200 hover:text-white">{t("publishingSettings.collapsedTitle")}</summary>
                <div className="border-t border-zinc-800 p-2">
                  <PublishingSettingsPanel channelId={channel?.id ?? null} visible={tab === "publishing"} />
                </div>
              </details>
            </div>
          </FeatureErrorBoundary>
        </div>
        <div className={tab === "calendar" ? undefined : "hidden"}>
          <FeatureErrorBoundary label={t("tabs.content.calendar")}>
            <PublishingCalendar channelId={channel?.id ?? null} visible={tab === "calendar"} />
          </FeatureErrorBoundary>
        </div>
        <div className={tab === "streams" ? undefined : "hidden"}>
          <FeatureErrorBoundary label={t("tabs.content.streams")}>
            <LiveStreamPanel channelId={channel?.id ?? null} visible={tab === "streams"} />
          </FeatureErrorBoundary>
        </div>
      </div>
      {children}
    </>
  );
}
