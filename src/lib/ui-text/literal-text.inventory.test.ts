import assert from "node:assert/strict";
import test from "node:test";
import { scanLiteralText } from "@/test-support/ui-text-literals";

// BL-152 (owner, Telegram 2026-10-07, msg 2027): "при добавлении чего-либо в инструмент — заводить ключи и переводы на все
// языки". Interface text lives in `src/lib/ui-text/locales/`, never as a literal in a component; the scan itself is in
// `src/test-support/ui-text-literals.ts`. A string that is not interface text (a technical identifier, a format sample, a
// product name) is marked on its line, or the line above, with `ui-text-ignore` and a reason.
//
// NOT_YET_MIGRATED lists the files still holding English while the interface is being moved over (BL-152 slices 2-4). It
// only shrinks: a listed file that is clean fails the test until it is removed from the list.
const NOT_YET_MIGRATED = new Set<string>([
  "src/components/agent-token-import-form.tsx",
  "src/components/ai-connections-manager.tsx",
  "src/components/analytics-breakdown-card.tsx",
  "src/components/analytics-data-strip.tsx",
  "src/components/analytics-line-chart.tsx",
  "src/components/analytics-manager.tsx",
  "src/components/analytics-tab.tsx",
  "src/components/app-version-info.tsx",
  "src/components/audience-analytics-panel.tsx",
  "src/components/batch-manager.tsx",
  "src/components/change-set-review.tsx",
  "src/components/channel-agent-token-field.tsx",
  "src/components/channel-connections-settings.tsx",
  "src/components/channel-overview-panel.tsx",
  "src/components/channel-workspace-field.tsx",
  "src/components/cloud-connection-settings.tsx",
  "src/components/cloud-quota-progress.tsx",
  "src/components/content-analytics-panel.tsx",
  "src/components/content-manager.tsx",
  "src/components/decisions-manager.tsx",
  "src/components/device-auto-sync-settings.tsx",
  "src/components/device-handoff-panel.tsx",
  "src/components/device-sync-divergence-card.tsx",
  "src/components/editorial-profile-panel.tsx",
  "src/components/factory-agent-token-settings.tsx",
  "src/components/gateway-traffic-stats.tsx",
  "src/components/generation-plans-panel.tsx",
  "src/components/home-dashboard-panel.tsx",
  "src/components/language-defaults-panel.tsx",
  "src/components/languages-manager.tsx",
  "src/components/live-writes-settings.tsx",
  "src/components/logical-paths-settings.tsx",
  "src/components/market-channel-assignment.tsx",
  "src/components/market-channel-collection-depth.tsx",
  "src/components/market-collection-requests-panel.tsx",
  "src/components/market-discovery-panel.tsx",
  "src/components/market-intelligence-collection-depth-settings.tsx",
  "src/components/market-intelligence-collection-settings.tsx",
  "src/components/market-research-panel.tsx",
  "src/components/market-research-requests-panel.tsx",
  "src/components/market-topics-panel.tsx",
  "src/components/market-trends-panel.tsx",
  "src/components/market-videos-panel.tsx",
  "src/components/mcp-connection-settings.tsx",
  "src/components/media-generation-settings.tsx",
  "src/components/media-job-progress.tsx",
  "src/components/media-review-player.tsx",
  "src/components/metric-delta.tsx",
  "src/components/music-chart-panel.tsx",
  "src/components/operations-workspace-settings.tsx",
  "src/components/operator-cli-settings.tsx",
  "src/components/plan-review-screen.tsx",
  "src/components/production-panel.tsx",
  "src/components/quota-block-dialog.tsx",
  "src/components/quota-history-dialog.tsx",
  "src/components/quota-reserve-settings.tsx",
  "src/components/reach-panel.tsx",
  "src/components/reach-status-block.tsx",
  "src/components/read-gateway-settings.tsx",
  "src/components/research-tab.tsx",
  "src/components/send-approved-button.tsx",
  "src/components/sync-folder-settings.tsx",
  "src/components/topic-wikipedia-signals.tsx",
  "src/components/video-detail-modal.tsx",
  "src/components/video-details-panel.tsx",
  "src/components/video-performance-table.tsx",
  "src/components/volume-usage-bar.tsx",
]);

test("the Web UI holds no English of its own: every text is an interface-text key (BL-152)", async () => {
  const found = await scanLiteralText();
  const stillListed = [...NOT_YET_MIGRATED].filter((file) => !found.has(file));
  const problems = [...found].filter(([file]) => !NOT_YET_MIGRATED.has(file)).flatMap(([file, lines]) => lines.map((l) => `${file}:${l}`));
  assert.deepEqual(stillListed, [], "these files are clean now -- remove them from NOT_YET_MIGRATED");
  assert.deepEqual(problems, [], "move these texts into src/lib/ui-text/locales (or mark a non-interface string with ui-text-ignore)");
});
