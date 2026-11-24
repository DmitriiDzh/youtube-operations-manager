import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { hashReviewFile, resolveReviewFile, workspaceRuleArgs } from "@/lib/review-items";
import type { ResolvedClipFile } from "../contracts";

// BL-241 (ADR 0061 §3): the clip files on this computer -- the shared workspace rule and the cached SHA-256 (since BL-272, ADR 0076,
// in the shared `review-items` module: the master still images use them too) and the shared ffprobe (`ffmpeg-host`).

export { workspaceRuleArgs };

export async function resolveClipFile(workspace: string, relativePath: string): Promise<({ ok: true } & ResolvedClipFile) | { ok: false; reason: string }> {
  return resolveReviewFile(workspace, relativePath);
}

const FFMPEG_KEY = Symbol.for("ytom.clipReviews.ffmpeg");
type Holder = typeof globalThis & { [FFMPEG_KEY]?: Promise<FfmpegTools | null> };
const holder = globalThis as Holder;

export async function probeClipDurationSeconds(absolutePath: string): Promise<number | null> {
  const tools = await (holder[FFMPEG_KEY] ??= detectFfmpeg());
  if (!tools) {
    holder[FFMPEG_KEY] = undefined; // look again next time (ffmpeg may be installed meanwhile)
    return null;
  }
  const probe = await probeMedia(tools, absolutePath).catch(() => null);
  return probe?.durationSeconds ?? null;
}

export async function hashClipFile(absolutePath: string): Promise<string> {
  return hashReviewFile(absolutePath);
}
