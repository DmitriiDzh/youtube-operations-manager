import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { createActivitySummary, type ActivitySummary } from "@/lib/activity-summary";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { collectLiveStreamEntries } from "@/lib/live-streams";
import { isFinished, listMediaJobsPool } from "@/lib/media-jobs-pool";
import { getOperationRegistry } from "@/lib/operation-progress";
import { listChannelUploads } from "@/lib/publishing";

// BL-195 stage D (UI_FEEDBACK_CLARITY_PLAN.md §3, AC-FB-08): what runs in the background now, for the header's Activity centre.
// Session required (401). The channel is the session's ACTIVE one, resolved by the summary, never taken from the request
// (ADR 0004 (b)). Read-only; codes and counts only. The sources are wired here, in the app layer: each is the owning module's own
// read, and the summary module imports none of them (AGENTS.md §M).

/** The real sources: each module's own read, never its tables. */
function activitySummaryCore() {
  return createActivitySummary({
    activeChannelOf: (userId) => createChannelAccessCore().getActiveChannelId(userId),
    operations: (channelId) => getOperationRegistry().list({ channelId, activeOnly: true }),
    mediaJobs: async (channelId) =>
      (await listMediaJobsPool({ channelId, kind: null, limit: 100 })).jobs.map((j) => ({
        jobId: j.jobId,
        source: j.source,
        status: j.status,
        label: j.label,
        hostName: j.hostName,
        own: j.own,
        createdAt: j.createdAt,
        finished: isFinished(j),
      })),
    uploads: async (channelId) => (await listChannelUploads(channelId)).map((u) => ({ id: u.id, video: u.video, status: u.status, storedBytes: u.storedBytes, totalBytes: u.totalBytes, createdAt: u.createdAt })),
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
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createActivityGetHandler();
