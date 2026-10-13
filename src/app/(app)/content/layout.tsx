"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { ContentManager } from "@/components/content-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { LiveStreamPanel } from "@/components/live-stream-panel";
import { PublishingCalendar } from "@/components/publishing-calendar";
import { CONTENT_TABS } from "@/components/section-tabs";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the section's own address. BL-176 (LIVE_STREAMS_PLAN.md §3.12): Content has
// two sub-tabs -- «Видео» (the list it always was) and «Трансляции» (the active channel's live stream). BL-182 adds «Календарь». Both stay mounted once
// shown and are only hidden, like the other sections' sub-tabs; both remount when the channel changes.
export default function ContentLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegment();
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
