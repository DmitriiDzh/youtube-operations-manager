import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { isValidIanaTimezone, isValidLocalTimeOfDay } from "@/lib/analytics/staleness";
import {
  getAnalyticsReadsEnabled,
  getAnalyticsSyncSettings,
  getDataApiReadsEnabled,
  getGatewayTrafficLast24h,
  getLiveWritesEnabled,
  getMcpConnectionEnabled,
  setAnalyticsReadsEnabled,
  setAnalyticsSyncSettings,
  setDataApiReadsEnabled,
  setLiveWritesEnabled,
  setMcpConnectionEnabled,
} from "@/lib/db";

/**
 * App-wide settings (Settings tab, owner instruction 2026-09-21). Two flags today:
 * - `liveWritesEnabled` -- Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09). Defaults off every
 *   process boot (`src/lib/db.ts`'s `initializeDatabase`), regardless of what was last saved;
 *   turning this on is layer 1 of the two-layer live-write barrier, not the write itself.
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
 *
 * **`GET` here is not purely read-only**: `getAnalyticsSyncSettings()` persists the OS-detected
 * timezone the first time it is ever read (`src/lib/db.ts`'s own doc comment). Two concurrent
 * first-ever `GET`s (e.g. this route's two consuming components both mounting at once) can both
 * detect-and-write -- benign, since `setAppSetting` is an upsert and both writes carry the same
 * value, but a `GET` with a real side effect is worth stating plainly rather than discovering
 * later while debugging something unrelated.
 */
async function getSettingsSnapshot() {
  const [
    liveWritesEnabled,
    mcpConnectionEnabled,
    analyticsSync,
    dataApiReadsEnabled,
    analyticsReadsEnabled,
    gatewayTraffic,
  ] = await Promise.all([
    getLiveWritesEnabled(),
    getMcpConnectionEnabled(),
    getAnalyticsSyncSettings(),
    getDataApiReadsEnabled(),
    getAnalyticsReadsEnabled(),
    getGatewayTrafficLast24h(),
  ]);

  return {
    liveWritesEnabled,
    mcpConnectionEnabled,
    analyticsSyncLocalTime: analyticsSync.localTime,
    analyticsSyncTimezone: analyticsSync.timezone,
    dataApiReadsEnabled,
    analyticsReadsEnabled,
    gatewayTraffic,
  };
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
  }

  if (typeof body.liveWritesEnabled === "boolean") {
    await setLiveWritesEnabled(body.liveWritesEnabled);
  }
  if (typeof body.mcpConnectionEnabled === "boolean") {
    await setMcpConnectionEnabled(body.mcpConnectionEnabled);
  }
  if (typeof body.dataApiReadsEnabled === "boolean") {
    await setDataApiReadsEnabled(body.dataApiReadsEnabled);
  }
  if (typeof body.analyticsReadsEnabled === "boolean") {
    await setAnalyticsReadsEnabled(body.analyticsReadsEnabled);
  }

  if (body.analyticsSyncLocalTime !== undefined) {
    if (typeof body.analyticsSyncLocalTime !== "string" || !isValidLocalTimeOfDay(body.analyticsSyncLocalTime)) {
      return NextResponse.json(
        { error: "validation_failed", message: "analyticsSyncLocalTime must be a valid 24-hour HH:MM string" },
        { status: 400 }
      );
    }
    await setAnalyticsSyncSettings({ localTime: body.analyticsSyncLocalTime });
  }

  if (body.analyticsSyncTimezone !== undefined) {
    if (typeof body.analyticsSyncTimezone !== "string" || !isValidIanaTimezone(body.analyticsSyncTimezone)) {
      return NextResponse.json(
        { error: "validation_failed", message: "analyticsSyncTimezone must be a valid IANA timezone name" },
        { status: 400 }
      );
    }
    await setAnalyticsSyncSettings({ timezone: body.analyticsSyncTimezone });
  }

  return NextResponse.json(await getSettingsSnapshot());
}
