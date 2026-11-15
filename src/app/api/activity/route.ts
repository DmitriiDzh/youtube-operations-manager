import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { createActivitySummary, type ActivitySummary } from "@/lib/activity-summary";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { collectLiveStreamEntries } from "@/lib/live-streams";
import { isFinished, listMediaJobsForAgent } from "@/lib/media-jobs-pool";
import { getOperationRegistry } from "@/lib/operation-progress";
import { listActiveUploadsWithQueue } from "@/lib/publishing";
import { createDefaultLogger } from "@/lib/shared-logger";

// BL-195 stage D (UI_FEEDBACK_CLARITY_PLAN.md §3, AC-FB-08): what runs in the background now, for the header's Activity centre.
// Session required (401). BL-258 (owner msg 4385): every channel's work (the owner's whole queue); the session's active channel is
// only reported alongside. Read-only; codes and counts only. The sources are wired here, in the app layer: each is the owning module's own
// read, and the summary module imports none of them (AGENTS.md §M).

/** The real sources: each module's own read, never its tables. */
function activitySummaryCore() {
  return createActivitySummary({
    activeChannelOf: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    // BL-258 (owner msg 4385): every channel's work -- the owner's queue, not the active channel's.
    operations: () => getOperationRegistry().list({ activeOnly: true }),
    mediaJobs: async () =>
      (await listMediaJobsForAgent({ limit: 500 })).jobs.map((j) => ({
        jobId: j.jobId,
        channelId: j.channelId ?? null,
        source: j.source,
        status: j.status,
        label: j.label,
        hostName: j.device.hostName,
        own: j.device.thisComputer,
        createdAt: j.createdAt,
        finished: isFinished(j),
        stale: j.stale,
        progress: j.progress ? { percent: j.progress.percent, step: j.progress.step } : null,
      })),
    uploads: async () =>
      (await listActiveUploadsWithQueue()).map((u) => ({ id: u.id, channelId: u.channelId, video: u.video, status: u.status, storedBytes: u.storedBytes, totalBytes: u.totalBytes, createdAt: u.createdAt, queuePosition: u.queuePosition })),
    streams: async () => (await collectLiveStreamEntries()).map((s) => ({ channelId: s.channelId, state: s.state, since: s.since })),
    now: () => new Date(),
  });
}

export type ActivityRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  summary: (userId: string) => Promise<ActivitySummary>;
};

export function createActivityGetHandler(
  deps: ActivityRouteDeps = {
    getSession: () => getServerSession(authOptions),
    summary: (userId) => activitySummaryCore().summary(userId),
  }
) {
  return async function GET() {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return NextResponse.json(await deps.summary(session.user.id), { headers: { "cache-control": "no-store" } });
    } catch (error) {
      // No error text: it could carry a database path (AC-FB-08).
      createDefaultLogger().error({ event: "activity.summary_failed", context: { message: error instanceof Error ? error.message : String(error) } });
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

export const GET = createActivityGetHandler();
