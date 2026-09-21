import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChangeDraftsCoreForProduction, isDomainError } from "@/lib/change-drafts";
import { listStoredChannels } from "@/lib/db";

const changeDrafts = createChangeDraftsCoreForProduction();

/**
 * Cheap, read-only conflict-count summary across every locally known channel -- deliberately
 * separate from `POST /api/change-drafts/sync` (which does real writes: exporting/pushing this
 * device's document, scanning the shared folder). Polled far more often than a sync cycle should
 * run (AC-CRDT-08's "accurate at all times a value is displayed" header badge), without paying
 * for a real push/merge cycle on every poll (advisor review: a write-classed endpoint hit every
 * few seconds from every open tab is wasteful and, without care, racy).
 *
 * Device-wide like `POST /api/change-drafts/sync` -- see that route's own comment for why no
 * `channelId`-scoping check applies here (every channel iterated is server-determined, never
 * client-supplied).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const channels = await listStoredChannels();
    const byChannel: Record<string, number> = {};

    for (const channel of channels) {
      try {
        const conflicts = await changeDrafts.listConflicts({ channelId: channel.channelId });
        if (conflicts.length > 0) byChannel[channel.channelId] = conflicts.length;
      } catch (error) {
        // A channel with no draft document at all yet has zero conflicts by definition --
        // `listConflicts` throws `not_found` rather than manufacture an empty document
        // (`change-drafts/services.ts`'s `loadDocumentOrThrow`); this is the expected common
        // case for most channels, not an error to surface.
        if (!(isDomainError(error) && error.code === "not_found")) throw error;
      }
    }

    const totalConflicts = Object.values(byChannel).reduce((sum, count) => sum + count, 0);
    return NextResponse.json({ totalConflicts, byChannel });
  } catch (error) {
    return NextResponse.json(
      { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
