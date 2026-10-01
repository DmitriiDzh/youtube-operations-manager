import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isValidIanaTimezone, isValidLocalTimeOfDay } from "@/lib/analytics/staleness";
import { createCloudQuotasCore } from "@/lib/cloud-quotas";
import { createMarketIntelligenceCore } from "@/lib/market-intelligence";
import {
  getAnalyticsReadsEnabled,
  getWikipediaReadsEnabled,
  getYoutubeFeedReadsEnabled,
  getAnalyticsSyncSettings,
  getDataApiReadsEnabled,
  getDeviceAutoSyncEnabled,
  getGatewayTrafficLast24h,
  getLiveWritesEnabled,
  getMcpConnectionEnabled,
  getOperatorCliEnabled,
  getOperationsWorkspacePath,
  setAnalyticsReadsEnabled,
  setWikipediaReadsEnabled,
  setYoutubeFeedReadsEnabled,
  setAnalyticsSyncSettings,
  setDataApiReadsEnabled,
  setDeviceAutoSyncEnabled,
  setLiveWritesEnabled,
  setMcpConnectionEnabled,
  setOperatorCliEnabled,
  setOperationsWorkspacePath,
} from "@/lib/db";
import { validateOperationsWorkspacePath } from "@/lib/operations-instructions";
import { buildSettingsSnapshot } from "./settings-snapshot";

// A thin passthrough to the market-intelligence module's own quota-budget actions, never a direct
// `@/lib/db` import for that setting -- this module's own PHASE9-INV-02 inventory test forbids any
// file outside it from reaching into its db.ts symbols directly (AGENTS.md §D/§M).
const marketIntelligenceCore = createMarketIntelligenceCore();

/**
 * App-wide settings (Settings tab, owner instruction 2026-09-21). Two flags today:
 * - `liveWritesEnabled` -- Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09). Reset to off when the
 *   web server starts and when it shuts down (`src/instrumentation.ts`), regardless of what was
 *   last saved;
 *   turning this on is layer 1 of the two-layer live-write barrier, not the write itself.
 * - `deviceAutoSyncEnabled` -- automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md
 *   §3.7). On by default, persistent, device-local.
 * - `operatorCliEnabled` -- Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md 12.5): whether the CLI
 *   may run at all, as the operator (agent mode removed, ADR 0013). Off by default, persistent.
 * - `mcpConnectionEnabled` -- the single gate for whether an MCP client sees ANY tool at all
 *   (renamed and inverted from the earlier "MCP restricted mode", owner instruction 2026-09-21:
 *   "по началу MCP / агент от всего отключен"). Unlike `liveWritesEnabled`, this persists across
 *   process boots -- a one-time setup toggle, not reset every session. Takes effect the next
 *   time an MCP client spawns/reconnects the server process, not for an already-open MCP
 *   connection (an MCP server's tool set is fixed at construction time).
 * - `analyticsSyncLocalTime`/`analyticsSyncTimezone` -- BL-059's daily auto-collection boundary
 *   (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-4). Unlike the two booleans above, these are
 *   validated before being persisted (`isValidLocalTimeOfDay`/`isValidIanaTimezone`) -- a bad
 *   timezone string would otherwise only surface as a thrown `RangeError` deep inside the
 *   staleness check on a later dashboard load, not at the point the owner actually typed it.
 * - `youtubeFeedReadsEnabled`/`wikipediaReadsEnabled` -- Phase 13 read categories (RSS feeds, Wikipedia
 *   Pageviews); same semantics as the two below: on by default, persistent.
 * - `dataApiReadsEnabled`/`analyticsReadsEnabled` -- per-category read-gateway toggles (owner
 *   instruction, 2026-09-22, `docs/decisions/0007-youtube-read-gateway.md`). Unlike the two
 *   booleans above, these default to **enabled** and persist across restarts (see
 *   `src/lib/db.ts`'s `getDataApiReadsEnabled` for the full rationale) -- disabling one also
 *   fails any write path that depends on that category's reads (intentional, see that same
 *   doc comment).
 * - `gatewayTraffic` -- read-only, not settable via `POST`: one row per gateway category
 *   (`data_api_reads`/`analytics_reads`/`live_writes`/`mcp_tool_calls`) with `totalAttempts`/
 *   `succeeded` for a rolling 24h window, from `src/lib/db.ts`'s `getGatewayTrafficLast24h`
 *   (owner instruction, 2026-09-22 -- "сколько было попыток пройти через шлюз за последние
 *   сутки... сколько попыток... увенчались успехом"). Only the last 24h, not all-time.
 * - `operationsWorkspacePath` -- Phase 7 slice I (owner spec §3/§30,
 *   `docs/AGENT_OPERATIONS_INTERFACE.md` §4i, Telegram 2026-09-24): an absolute path to a folder
 *   OUTSIDE this repository holding Codex's own operating/editorial instructions -- surfaced to
 *   the connected agent via the read-only `agent_list_operations_files`/`agent_get_operations_file`
 *   MCP tools/CLI commands, never generated or committed here (`AGENTS.md` §B). `null` means
 *   unconfigured. Set-time validation (`validateOperationsWorkspacePath`) rejects a non-absolute
 *   path, a path that doesn't exist/isn't a directory, or one that overlaps this application's own
 *   app-data directory (RISK-07: plaintext OAuth tokens live there) -- the SAME check the read
 *   path independently re-runs on every request, since the directory could be re-symlinked to
 *   something unsafe after being validated here. This is the ONLY way to set this path -- no
 *   `agent`-namespaced MCP tool or CLI command can (owner spec §17's `local_path` self-
 *   authorization concern, applied here: an agent that could choose its own instructions
 *   directory would be authorizing its own filesystem access).
 * - `marketIntelligenceDailyQuotaBudgetUnits` -- Phase 9 slice 9B
 *   (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md` §4, owner decision 2026-09-26: "пользователь
 *   сам в настройках мог это выставить... от того числа строить логику" -- a plain operator-set
 *   number, no hardcoded default). `null`/unset means the repeatable competitor refresh is OFF; a
 *   real `<input type="range">` slider in the Settings tab is this value's own UI (never a
 *   locale-formatted display, `settings-input-widget-conventions`). The window this budget resets
 *   against is YouTube's quota day, midnight Pacific time (`startOfYoutubeQuotaDay` in the pure
 *   `src/lib/youtube-quota` leaf, Phase 13 slice 13.4) -- the same boundary YouTube resets its own
 *   quota on; `cloudQuotaStatus` below is still a separate, Cloud Monitoring number.
 * - `cloudQuotaStatus` -- read-only, not settable via `POST`: real Google Cloud quota
 *   limit/usage from the Cloud Monitoring API (`docs/decisions/0008-cloud-connection.md`'s
 *   follow-up, owner instruction 2026-09-22 -- "сколько максимальная квота... сколько из неё
 *   уже использовано"). `dataApi` covers BOTH Data API v3 reads and Live writes (same
 *   underlying Google service, owner instruction: "Можем пока что отображать на Live write и
 *   на Data reads один и тот же счетчик"); `analytics` is a separate quota pool. Each is `null`
 *   when Cloud isn't connected yet or the real query failed -- never a fabricated number.
 *
 * **`GET` here is not purely read-only**: `getAnalyticsSyncSettings()` persists the OS-detected
 * timezone the first time it is ever read (`src/lib/db.ts`'s own doc comment). Two concurrent
 * first-ever `GET`s (e.g. this route's two consuming components both mounting at once) can both
 * detect-and-write -- benign, since `setAppSetting` is an upsert and both writes carry the same
 * value, but a `GET` with a real side effect is worth stating plainly rather than discovering
 * later while debugging something unrelated.
 */
async function getSettingsSnapshot() {
  return buildSettingsSnapshot({
    liveWritesEnabled: () => getLiveWritesEnabled(),
    mcpConnectionEnabled: () => getMcpConnectionEnabled(),
    analyticsSync: () => getAnalyticsSyncSettings(),
    dataApiReadsEnabled: () => getDataApiReadsEnabled(),
    analyticsReadsEnabled: () => getAnalyticsReadsEnabled(),
    youtubeFeedReadsEnabled: () => getYoutubeFeedReadsEnabled(),
    wikipediaReadsEnabled: () => getWikipediaReadsEnabled(),
    gatewayTraffic: () => getGatewayTrafficLast24h(),
    cloudQuotaStatus: () => createCloudQuotasCore().getQuotaStatus(),
    operationsWorkspacePath: () => getOperationsWorkspacePath(),
    marketIntelligenceDailyQuotaBudgetUnits: () => marketIntelligenceCore.getDailyQuotaBudgetUnits(),
    operatorCliEnabled: () => getOperatorCliEnabled(),
    deviceAutoSyncEnabled: () => getDeviceAutoSyncEnabled(),
  });
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await getSettingsSnapshot());
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
  }
  // A well-formed-but-non-object body (e.g. a literal `null`) parses fine as JSON, so it must be
  // handled here rather than destructured directly (same fix already applied to the market-
  // intelligence routes -- found by independent code review, this route was not brought in line
  // when it gained the marketIntelligenceDailyQuotaBudgetUnits field below).
  const body: Record<string, unknown> = typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : {};

  // Found by independent review (2026-09-29): this route used to validate-and-apply each field in
  // one pass, so a later field failing validation still left every EARLIER field's write already
  // persisted -- a client sending liveWritesEnabled plus an invalid marketIntelligenceDailyQuota-
  // BudgetUnits in the same request saw a 400 while liveWritesEnabled had already taken effect.
  // Restructured into two passes: validate every field first (collecting what to write, never
  // writing anything), then apply every write only once all of them have passed. No field's
  // validation or write depends on another field's write already having landed, so this reordering
  // changes nothing about what a fully-valid request ends up persisting.
  let analyticsSyncLocalTimeToSet: string | undefined;
  if (body.analyticsSyncLocalTime !== undefined && body.analyticsSyncLocalTime !== null) {
    if (typeof body.analyticsSyncLocalTime !== "string" || !isValidLocalTimeOfDay(body.analyticsSyncLocalTime)) {
      return NextResponse.json(
        { error: "validation_failed", message: "analyticsSyncLocalTime must be a valid 24-hour HH:MM string" },
        { status: 400 }
      );
    }
    analyticsSyncLocalTimeToSet = body.analyticsSyncLocalTime;
  }

  let analyticsSyncTimezoneToSet: string | undefined;
  if (body.analyticsSyncTimezone !== undefined && body.analyticsSyncTimezone !== null) {
    if (typeof body.analyticsSyncTimezone !== "string" || !isValidIanaTimezone(body.analyticsSyncTimezone)) {
      return NextResponse.json(
        { error: "validation_failed", message: "analyticsSyncTimezone must be a valid IANA timezone name" },
        { status: 400 }
      );
    }
    analyticsSyncTimezoneToSet = body.analyticsSyncTimezone;
  }

  let marketIntelligenceQuotaToSet: { present: true; value: number | null } | { present: false } = { present: false };
  if (body.marketIntelligenceDailyQuotaBudgetUnits !== undefined) {
    if (body.marketIntelligenceDailyQuotaBudgetUnits === null) {
      marketIntelligenceQuotaToSet = { present: true, value: null };
    } else if (
      typeof body.marketIntelligenceDailyQuotaBudgetUnits !== "number" ||
      !Number.isFinite(body.marketIntelligenceDailyQuotaBudgetUnits) ||
      !Number.isInteger(body.marketIntelligenceDailyQuotaBudgetUnits) ||
      body.marketIntelligenceDailyQuotaBudgetUnits < 0
    ) {
      return NextResponse.json(
        { error: "validation_failed", message: "marketIntelligenceDailyQuotaBudgetUnits must be a non-negative integer or null" },
        { status: 400 }
      );
    } else {
      // 0 means the same thing as null (off) at the storage layer -- normalized to null here
      // (found by independent review: an earlier comment claimed this was passed through as-is,
      // which the code below never actually did) so a caller reading the setting back afterward
      // sees null either way, never a stored literal 0 sometimes and null other times.
      marketIntelligenceQuotaToSet = {
        present: true,
        value: body.marketIntelligenceDailyQuotaBudgetUnits === 0 ? null : body.marketIntelligenceDailyQuotaBudgetUnits,
      };
    }
  }

  let operationsWorkspacePathToSet: { present: true; value: string | null } | { present: false } = { present: false };
  if (body.operationsWorkspacePath !== undefined) {
    if (body.operationsWorkspacePath === null || body.operationsWorkspacePath === "") {
      operationsWorkspacePathToSet = { present: true, value: null };
    } else if (typeof body.operationsWorkspacePath !== "string") {
      return NextResponse.json(
        { error: "validation_failed", message: "operationsWorkspacePath must be a string or null" },
        { status: 400 }
      );
    } else {
      const validation = await validateOperationsWorkspacePath(body.operationsWorkspacePath);
      if (!validation.ok) {
        return NextResponse.json({ error: "validation_failed", message: validation.reason }, { status: 400 });
      }
      operationsWorkspacePathToSet = { present: true, value: body.operationsWorkspacePath };
    }
  }

  // Every field above has now validated successfully (or this line is unreached) -- only now does
  // any write actually happen.
  if (typeof body.liveWritesEnabled === "boolean") {
    await setLiveWritesEnabled(body.liveWritesEnabled);
  }
  if (typeof body.mcpConnectionEnabled === "boolean") {
    await setMcpConnectionEnabled(body.mcpConnectionEnabled);
  }
  if (typeof body.operatorCliEnabled === "boolean") {
    await setOperatorCliEnabled(body.operatorCliEnabled);
  }
  if (typeof body.deviceAutoSyncEnabled === "boolean") {
    await setDeviceAutoSyncEnabled(body.deviceAutoSyncEnabled);
  }
  if (typeof body.dataApiReadsEnabled === "boolean") {
    await setDataApiReadsEnabled(body.dataApiReadsEnabled);
  }
  if (typeof body.analyticsReadsEnabled === "boolean") {
    await setAnalyticsReadsEnabled(body.analyticsReadsEnabled);
  }
  if (typeof body.youtubeFeedReadsEnabled === "boolean") {
    await setYoutubeFeedReadsEnabled(body.youtubeFeedReadsEnabled);
  }
  if (typeof body.wikipediaReadsEnabled === "boolean") {
    await setWikipediaReadsEnabled(body.wikipediaReadsEnabled);
  }
  if (analyticsSyncLocalTimeToSet !== undefined) {
    await setAnalyticsSyncSettings({ localTime: analyticsSyncLocalTimeToSet });
  }
  if (analyticsSyncTimezoneToSet !== undefined) {
    await setAnalyticsSyncSettings({ timezone: analyticsSyncTimezoneToSet });
  }
  if (marketIntelligenceQuotaToSet.present) {
    await marketIntelligenceCore.setDailyQuotaBudgetUnits(marketIntelligenceQuotaToSet.value);
  }
  if (operationsWorkspacePathToSet.present) {
    await setOperationsWorkspacePath(operationsWorkspacePathToSet.value);
  }

  return NextResponse.json(await getSettingsSnapshot());
}
