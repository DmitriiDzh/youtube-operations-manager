"use client";

import { notFound, useRouter, useSelectedLayoutSegment } from "next/navigation";
import type { ReactNode } from "react";
import { AiConnectionsManager } from "@/components/ai-connections-manager";
import { AnalyticsCollectionSettings } from "@/components/analytics-collection-settings";
import { MarketIntelligenceCollectionSettings } from "@/components/market-intelligence-collection-settings";
import { MarketIntelligenceCollectionDepthSettings } from "@/components/market-intelligence-collection-depth-settings";
import { QuotaReserveSettings } from "@/components/quota-reserve-settings";
import { RetentionSettings } from "@/components/retention-settings";
import { LiveWritesSettings } from "@/components/live-writes-settings";
import { McpConnectionSettings } from "@/components/mcp-connection-settings";
import { OperationsWorkspaceSettings } from "@/components/operations-workspace-settings";
import { LogicalPathsSettings } from "@/components/logical-paths-settings";
import { FactoryAgentTokenSettings } from "@/components/factory-agent-token-settings";
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

// Settings sub-tabs (owner instruction, 2026-09-23: "давай в настройках сделаем 4 категории
// закладок"). "AI Agent" deliberately groups two technically unrelated mechanisms -- the MCP
// connection toggle (how an external AI agent like Codex/Claude connects TO this app) and AI
// provider connections (how this app connects OUT to an AI provider for AI Localization) -- per
// the owner's own explicit choice after this distinction was raised and confirmed understood.
const SETTINGS_SUB_TABS = [
  { value: "general", label: "General" },
  { value: "api", label: "API" },
  { value: "channels", label: "Channels" },
  { value: "ai-agent", label: "AI Agent" },
  { value: "sync", label: "Sync" },
  // Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6, D5): the RunPod connection only since slice 6 (owner, msg 1549);
  // everything else is the Production section.
  { value: "runpod", label: "RunPod" },
  { value: "about", label: "About" },
] as const;
type SettingsSubTab = (typeof SETTINGS_SUB_TABS)[number]["value"];

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): Settings at `/settings/<sub-tab>`. The cards live in this layout, which
// persists while only the sub-tab changes, so every visited sub-tab stays mounted and is only hidden (no reload on a switch).
// Settings now loads on its first open, not with the app (owner, msg 2004: option b).
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const segment = useSelectedLayoutSegment();
  const settingsSubTab: SettingsSubTab | undefined = SETTINGS_SUB_TABS.find((t) => t.value === segment)?.value;
  if (segment !== null && !settingsSubTab) notFound();
  const setSettingsSubTab = (next: SettingsSubTab) => router.push(`/settings/${next}`);
  if (!settingsSubTab) return <>{children}</>;
  return (
    <>
    <div className="max-w-3xl">
      <div className="mb-6 inline-flex gap-1 rounded-lg bg-zinc-950 p-1">
        {SETTINGS_SUB_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setSettingsSubTab(t.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              settingsSubTab === t.value ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
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
        <FeatureErrorBoundary label="Settings — Retention">
          <RetentionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Analytics collection">
          <AnalyticsCollectionSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "api" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — Live writes">
          <LiveWritesSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Data reads">
          <ReadGatewaySettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Google Cloud">
          <CloudConnectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Quota reserve">
          <QuotaReserveSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Market intelligence collection">
          <MarketIntelligenceCollectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Competitor collection depth">
          <MarketIntelligenceCollectionDepthSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "channels" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — Channels">
          <ChannelConnectionsSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "ai-agent" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — MCP connection">
          <McpConnectionSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Operator CLI">
          <OperatorCliSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Operations workspace">
          <OperationsWorkspaceSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Logical paths">
          <LogicalPathsSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Factory Operator token">
          <FactoryAgentTokenSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — AI providers">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <h3 className="mb-4 flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              AI provider connections
              <InfoTooltip>
                Configure AI provider connections for AI Localization. No specific vendor is
                built into this app &mdash; every connection is a Base URL, model id, and
                optional credential you supply. Credentials are encrypted at rest and never
                shown again once saved. Testing a connection is an explicit action and may
                incur cost for a real (non-mock) connection. Unrelated to the MCP connection
                above (that&rsquo;s an external agent connecting TO this app; this is this app
                connecting OUT to an AI provider) &mdash; grouped here for convenience.
              </InfoTooltip>
            </h3>
            <AiConnectionsManager />
          </div>
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "sync" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — Sync">
          <SyncFolderSettings />
        </FeatureErrorBoundary>
        <FeatureErrorBoundary label="Settings — Automatic device sync">
          <DeviceAutoSyncSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "runpod" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — RunPod">
          <RunpodConnectionSettings />
        </FeatureErrorBoundary>
      </div>

      <div className={settingsSubTab === "about" ? "space-y-6" : "hidden"}>
        <FeatureErrorBoundary label="Settings — About">
          <AppVersionInfo />
        </FeatureErrorBoundary>
      </div>
    </div>
      {children}
    </>
  );
}
