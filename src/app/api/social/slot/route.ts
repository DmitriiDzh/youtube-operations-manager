import { NextResponse } from "next/server";
import { slotCrossPostPreview } from "@/composition/cross-posting-plan";
import { DomainError, parseCrossPostBlock, videoProblems } from "@/lib/cross-posting";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252 stage 2 (AC-XP-15): the social part of one weekly-plan slot's package for «План недели» -- networks, texts, problems
// (the block's and the video's against each network), and this computer's jobs for that video. Read-only.
export function createSlotPreviewHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const q = new URL(request.url).searchParams;
    const channelId = q.get("channelId")?.trim();
    const video = q.get("video")?.trim();
    const sha = q.get("manifestSha256")?.trim();
    if (!channelId || !video || !sha || !/^V\d+$/.test(video) || !/^[0-9a-f]{64}$/.test(sha)) throw new DomainError({ code: "validation_failed", message: "channelId, video and manifestSha256 are required" });
    const preview = await slotCrossPostPreview(channelId, video, sha);
    if (!preview || preview.crossPost === null) return NextResponse.json({ targets: [], problems: [], jobs: [] });
    const { targets, problems } = parseCrossPostBlock(preview.crossPost);
    const all = [...problems, ...videoProblems(targets, preview), ...(targets.length > 0 && !preview.videoSha256 ? [{ network: null, code: "video_hash_required" }] : [])];
    const accounts = await core.listAccounts(channelId);
    const notConnected = targets.filter((t) => !accounts.some((a) => a.network === t.network)).map((t) => ({ network: t.network, code: "not_connected" }));
    const jobs = (await core.listJobs(channelId)).filter((j) => j.video === video).map((j) => ({ network: j.network, status: j.status, permalink: j.permalink, errorCode: j.errorCode }));
    return NextResponse.json({ targets, problems: [...all, ...notConnected], jobs });
  });
}

export const GET = createSlotPreviewHandler();
