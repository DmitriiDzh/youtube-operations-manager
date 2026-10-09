"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { AnalyticsCollectionSettings } from "@/components/analytics-collection-settings";
import { MarketIntelligenceCollectionSettings } from "@/components/market-intelligence-collection-settings";
import { MarketIntelligenceCollectionDepthSettings } from "@/components/market-intelligence-collection-depth-settings";
import { MarketIntelligenceInactivitySettings } from "@/components/market-intelligence-inactivity-settings";
import { QuotaReserveSettings } from "@/components/quota-reserve-settings";
import { RetentionSettings } from "@/components/retention-settings";
import { LiveWritesSettings } from "@/components/live-writes-settings";
import { McpConnectionSettings } from "@/components/mcp-connection-settings";
import { OperationsWorkspaceSettings } from "@/components/operations-workspace-settings";
import { LogicalPathsSettings } from "@/components/logical-paths-settings";
import { FactoryAgentTokenSettings } from "@/components/factory-agent-token-settings";
import { ProducerAgentTokenSettings } from "@/components/producer-agent-token-settings";
import { OperatorCliSettings } from "@/components/operator-cli-settings";
import { ReadGatewaySettings } from "@/components/read-gateway-settings";
import { CloudConnectionSettings } from "@/components/cloud-connection-settings";
import { ChannelConnectionsSettings } from "@/components/channel-connections-settings";
import { SyncFolderSettings } from "@/components/sync-folder-settings";
import { RunpodConnectionSettings } from "@/components/media-generation-settings";
import { DeviceAutoSyncSettings } from "@/components/device-auto-sync-settings";
import { AppVersionInfo } from "@/components/app-version-info";
import { InfoTooltip } from "@/components/info-tooltip";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { UiLanguageSettings } from "@/components/ui-language-settings";
import { useT } from "@/components/ui-text-provider";
import type { UiTextKey } from "@/lib/ui-text";

import { SETTINGS_SUB_TABS, type SettingsSubTab } from "@/components/section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Settings at `/settings/<sub-tab>`. The cards live in this layout, which
// persists while only the sub-tab changes, so every visited sub-tab stays mounted and is only hidden (no reload on a switch).
// Settings now loads on its first open, not with the app (owner, msg 2004: option b).
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const t = useT();
  // A crashed card names itself in the error fallback ("Settings — Retention").
  const section = (card: UiTextKey) => `${t("nav.settings")} — ${t(card)}`;
  const segment = useSelectedLayoutSegment();
  const settingsSubTab: SettingsSubTab | undefined = SETTINGS_SUB_TABS.find((t) => t.value === segment)?.value;
  const setSettingsSubTab = (next: SettingsSubTab) => router.push(`/settings/${next}`);
  if (!settingsSubTab) return <>{children}</>;
  return (
    <>
    <div className="max-w-3xl">
      <div className="mb-6 inline-flex gap-1 rounded-lg bg-zinc-950 p-1">
        {SETTINGS_SUB_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setSettingsSubTab(tab.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              settingsSubTab === tab.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Every sub-tab's content stays mounted (hidden via CSS, not unmounted) once first
          shown -- found live (owner: "почему при переключении подкатегорий наполнение
          вкладки видно не сразу?"): each card below does its own fetch-on-mount, so
          conditionally unmounting on every switch forced a fresh loading flicker (or a blank
          `if (!draft) return null` render) every single time, even for a sub-tab already
          visited this session. Hidden-not-unmounted keeps each card's already-fetched state,
          so only the FIRST visit to a sub-tab shows a loading moment. */}
      {/* General: settings that are not about an API connection (owner instruction, 2026-10-04: the API
          sub-tab was collecting too much unrelated content). */}
      <div className={settingsSubTab === "general" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.uiLanguage")}>
          <UiLanguageSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.retention")}>
          <RetentionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.analyticsCollection")}>
          <AnalyticsCollectionSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "api" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.liveWrites")}>
          <LiveWritesSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.dataReads")}>
          <ReadGatewaySettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.googleCloud")}>
          <CloudConnectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.quotaReserve")}>
          <QuotaReserveSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.marketCollection")}>
          <MarketIntelligenceCollectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.competitorDepth")}>
          <MarketIntelligenceCollectionDepthSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.competitorInactivity")}>
          <MarketIntelligenceInactivitySettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "channels" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.channels")}>
          <ChannelConnectionsSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "ai-agent" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.mcp")}>
          <McpConnectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.operatorCli")}>
          <OperatorCliSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.operationsWorkspace")}>
          <OperationsWorkspaceSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.logicalPaths")}>
          <LogicalPathsSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.factoryToken")}>
          <FactoryAgentTokenSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.producerToken")}>
          <ProducerAgentTokenSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.aiProviders")}>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-4 flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              {t("aiProviders.title")}
              <InfoTooltip>{t("aiProviders.info")}</InfoTooltip>
            </h3>
            <AiConnectionsManager />
          </div>
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "sync" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.sync")}>
          <SyncFolderSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label={section("settingsCard.autoDeviceSync")}>
          <DeviceAutoSyncSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "runpod" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.runpod")}>
          <RunpodConnectionSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "about" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label={section("settingsCard.about")}>
          <AppVersionInfo />
        </FeatureErrorBoundary>
      </div>
    </div>
      {children}
    </>
  );
}
