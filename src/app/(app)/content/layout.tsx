"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { ContentManager } from "@/components/content-manager";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { LiveStreamPanel } from "@/components/live-stream-panel";
import { PlanExtras, type PlanPackageRow } from "@/components/plan-extras";
import { activeUploadsByVideo } from "@/components/plan-extras-model";
import type { UploadRow } from "@/components/publishing-uploads";
import { WeeklyPlanPanel } from "@/components/weekly-plan-panel";
import { WeeklyTemplateBuildCard } from "@/components/weekly-template-build-card";
import { CONTENT_TABS } from "@/components/section-tabs";
import { useContentTabBadges } from "@/components/content-tab-badges";
import { useT } from "@/components/ui-text-provider";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the section's own address. BL-176 (LIVE_STREAMS_PLAN.md §3.12): Content has
// two sub-tabs -- «Видео» (the list it always was) and «Трансляции» (the active channel's live stream). BL-182 adds «Календарь» and «Публикация». Both stay mounted once
// shown and are only hidden, like the other sections' sub-tabs; both remount when the channel changes. BL-266 (owner TG 4730/4732): «Публикация»
// is gone -- its videos without a slot, upload queue and packages are on «План» (PlanExtras), its two settings cards in Settings → Channels.
export default function ContentLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegment();
  // BL-221 (CONTENT_UX_PLAN.md stage E): what each tab is waiting for, on the tab itself.
  const badges = useContentTabBadges(channel?.id ?? null);
  // BL-266: «План»'s queue line and package scan feed its slot cards (one read each).
  // Each kept with its channel: another channel's rows (the same video numbers) never reach this channel's cards.
  const channelId = channel?.id ?? null;
  const [uploadRows, setUploadRows] = useState<{ channelId: string | null; rows: UploadRow[] }>({ channelId: null, rows: [] });
  const [packageRows, setPackageRows] = useState<{ channelId: string | null; rows: PlanPackageRow[] }>({ channelId: null, rows: [] });
  const [packagesKey, setPackagesKey] = useState(0);
  const uploadsByVideo = useMemo(() => activeUploadsByVideo(uploadRows.channelId === channelId ? uploadRows.rows : []), [uploadRows, channelId]);
  const packagesBySha = useMemo(
    () => new Map((packageRows.channelId === channelId ? packageRows.rows : []).filter((p) => p.manifestSha256).map((p) => [p.manifestSha256 as string, p])),
    [packageRows, channelId]
  );
  const onUploads = useCallback((rows: UploadRow[]) => setUploadRows({ channelId, rows }), [channelId]);
  const onPackages = useCallback((rows: PlanPackageRow[]) => setPackageRows({ channelId, rows }), [channelId]);
  const onPackagingChanged = useCallback(() => setPackagesKey((k) => k + 1), []);
  const tab = CONTENT_TABS.find((item) => item.value === segment)?.value ?? null;
  if (!tab) return <>{children}</>;
  return (
    <>
      <div className="ytom-tabrow mb-4 inline-flex gap-1 rounded-lg bg-zinc-950 p-1" role="tablist">
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
            {/* BL-266: the former «Ролики и релизы» count -- videos ready for a package or an upload -- is on «План» now. */}
            {item.value === "week-plan" && badges.releases > 0 && (
              <span className="ml-1.5 rounded-full bg-violet-600/80 px-1.5 text-[10px] font-semibold text-white" title={t("contentTabs.badge.releases", { count: badges.releases })}>
                {badges.releases}
              </span>
            )}
            {/* BL-267: the coverage warning of the former «Календарь» tab is on «План» now. */}
            {item.value === "week-plan" && badges.calendarDue && (
              <span className="ml-1.5 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-zinc-950" title={t("contentTabs.badge.calendar")}>
                !
              </span>
            )}
            {item.value === "week-plan" && badges.weekPlan > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/90 px-1.5 text-[10px] font-semibold text-zinc-950" title={t("contentTabs.badge.weekPlan", { count: badges.weekPlan })}>
                {badges.weekPlan}
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
        {/* BL-225 (ADR 0051, AGENTS.md §M): the weekly plan in its own boundary -- Content works without it. */}
        <div className={tab === "week-plan" ? undefined : "hidden"}>
          {/* BL-266 (AGENTS.md §M): the former «Ролики и релизы» lines in their own boundary -- the plan works without them. */}
          <div className="mb-4">
            <FeatureErrorBoundary label={t("planExtras.packages.close")}>
              <PlanExtras channelId={channel?.id ?? null} visible={tab === "week-plan"} onUploads={onUploads} onPackages={onPackages} packagesRefreshKey={packagesKey} />
            </FeatureErrorBoundary>
          </div>
          <FeatureErrorBoundary label={t("tabs.content.weekPlan")}>
            <WeeklyPlanPanel channelId={channel?.id ?? null} visible={tab === "week-plan"} uploads={uploadsByVideo} packages={packagesBySha} onPackagingChanged={onPackagingChanged} />
          </FeatureErrorBoundary>
          {/* BL-231 (FO-REQ-0046, AGENTS.md §M): the factory's weekly build in its own boundary -- the plan works without it. BL-267
              (owner O7): «Собрать неделю по шаблону», shown only for a music template (the card hides itself otherwise). */}
          <div className="mt-4">
            <FeatureErrorBoundary label={t("weeklyBuild.title")}>
              <WeeklyTemplateBuildCard channelId={channel?.id ?? null} visible={tab === "week-plan"} />
            </FeatureErrorBoundary>
          </div>
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
