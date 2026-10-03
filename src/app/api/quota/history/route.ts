import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createQuotaHistoryCore } from "@/lib/quota-history";

const core = createQuotaHistoryCore();

/**
 * BL-117 -- the quota-spend history behind the Settings popup (`docs/roadmap/plans/QUOTA_HISTORY_AND_GUARD_PLAN.md`):
 * one entry per piece of work, the next reset time, and how much of Google's usage this device's log does not explain.
 * Read-only; returns method counts and unit totals only (no tokens, no video titles). GET: never gated by the mutation check.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const service = params.get("service") === "analytics" ? "analytics" : "data";
  const days = Number(params.get("days") ?? "");
  const history = await core.getQuotaHistory({ service, days: Number.isFinite(days) && days > 0 ? days : undefined });
  return NextResponse.json(history);
}
