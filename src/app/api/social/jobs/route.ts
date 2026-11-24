import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252 stage 2: this computer's cross-posting jobs (status, post link, error), newest first; `?channelId=` narrows. No token.
// `ownerRetryAt` (owner TG 4780): the owner's retry still waiting for the runner (null: none) -- the screen shows «Повтор запрошен»
// instead of the Retry button while it is set.
export function createJobsGetHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const channelId = new URL(request.url).searchParams.get("channelId")?.trim() || null;
    const jobs = (await core.listJobs(channelId)).slice(0, 50).map((j) => ({ jobId: j.jobId, channelId: j.channelId, slotId: j.slotId, video: j.video, network: j.network, plannedAt: j.plannedAt, status: j.status, remotePostId: j.remotePostId, publishAttempted: j.publishAttempted, permalink: j.permalink, errorCode: j.errorCode, errorMessage: j.errorMessage, updatedAt: j.updatedAt, ownerRetryAt: j.ownerRetryAt ?? null }));
    return NextResponse.json({ jobs });
  });
}

export const GET = createJobsGetHandler();
