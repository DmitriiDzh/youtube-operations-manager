import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252 stage 2: this computer's cross-posting jobs (status, post link, error), newest first; `?channelId=` narrows. No token.
export function createJobsGetHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const channelId = new URL(request.url).searchParams.get("channelId")?.trim() || null;
    const jobs = (await core.listJobs(channelId)).slice(0, 50).map((j) => ({ jobId: j.jobId, channelId: j.channelId, slotId: j.slotId, video: j.video, network: j.network, plannedAt: j.plannedAt, status: j.status, remotePostId: j.remotePostId, permalink: j.permalink, errorCode: j.errorCode, errorMessage: j.errorMessage, updatedAt: j.updatedAt }));
    return NextResponse.json({ jobs });
  });
}

export const GET = createJobsGetHandler();
