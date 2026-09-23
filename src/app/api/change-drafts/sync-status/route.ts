import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getSyncFamilyStatuses } from "@/lib/db";

/**
 * Read-only, persistent last-sync-outcome per sync-gateway family (2026-09-23, Merge-tab
 * redesign) -- unlike the transient summary `POST /api/change-drafts/sync` itself returns
 * (which only exists in the browser tab that triggered it and vanishes on reload), this reads
 * `sync_family_status` directly, so the Merge tab can show "last synced 3 minutes ago, ok" even
 * on a fresh page load, before ever calling Sync now itself. Never triggers a sync cycle.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const statuses = await getSyncFamilyStatuses();
  return NextResponse.json({ statuses });
}
