import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import type { PlannedCrossPost } from "@/lib/cross-posting";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { createPackageScanCore, createPublishingSettingsCore, type ScannedPackage } from "@/lib/publishing";
import { createPublishingPlansSocialCore, type SocialSlotState } from "@/lib/publishing-plans";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";

// ---------------------------------------------------------------------------
// BL-252 stage 2 (ADR 0068 amendment 1 §5, AGENTS.md §M): the cross-posting runner's plan source, composed at the app layer --
// `publishing` and `publishing-plans` never import `cross-posting`. For every approved slot (the plan's social read) it finds the
// slot's package by the approved manifest SHA-256, reads the manifest bytes ONCE, checks they hash to what the owner approved, and
// parses `crossPost`, the video's own `sha256` and the AI flag from those same bytes. The video must sit inside the channel's
// workspace (real path). Read-only.
// ---------------------------------------------------------------------------

const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const FFMPEG_KEY = Symbol.for("ytom.crossPosting.ffmpeg");
const holder = globalThis as unknown as Record<symbol, Promise<FfmpegTools | null> | undefined>;

async function ffprobe(): Promise<FfmpegTools | null> {
  const found = await (holder[FFMPEG_KEY] ??= detectFfmpeg());
  if (!found) holder[FFMPEG_KEY] = undefined;
  return found;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function uploadBodyOf(filePath: string, sizeBytes: number) {
  return { stream: () => Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>, sizeBytes };
}

/** The approved slots of one channel that carry a `crossPost` block, ready for the runner. Errors per slot are skipped (fail closed). */
export async function plannedCrossPostsOf(channelId: string): Promise<PlannedCrossPost[]> {
  const states = (await createPublishingPlansSocialCore(publishingPlanProgress).socialSlotStates(channelId)).filter((s) => s.approved && s.package);
  if (states.length === 0) return [];
  const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
  if (!workspace.configured) return [];
  const root = await realpath(workspace.path).catch(() => null);
  if (!root) return [];
  const scan = await createPackageScanCore().scan(channelId);
  if (scan.status !== "ok") return [];
  const channelSynthetic = (await createPublishingSettingsCore().read(channelId)).settings.containsSyntheticMedia;
  const out: PlannedCrossPost[] = [];
  for (const state of states) {
    const entry = await entryOf(channelId, state, root, scan.packages, channelSynthetic).catch(() => null);
    if (entry) out.push(entry);
  }
  return out;
}

async function entryOf(
  channelId: string,
  state: SocialSlotState,
  root: string,
  packages: readonly ScannedPackage[],
  channelSynthetic: boolean
): Promise<PlannedCrossPost | null> {
  const fp = state.package!;
  const scanned = packages.find((p) => p.manifestSha256 === fp.manifestSha256 && p.pkg?.video === fp.video);
  if (!scanned) return null;
  const manifestPath = await realpath(path.join(root, ...scanned.manifestPath.split("/")));
  if (!isPathInsideOrEqual(root, manifestPath)) return null;
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > MANIFEST_MAX_BYTES || sha256Hex(bytes) !== fp.manifestSha256) return null; // changed since the approval
  const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (raw.crossPost === undefined || raw.crossPost === null) return null;
  const files = (raw.files ?? {}) as Record<string, unknown>;
  if (typeof files.video !== "string") return null;
  const videoPath = await realpath(path.join(path.dirname(manifestPath), files.video)).catch(() => null);
  if (!videoPath || !isPathInsideOrEqual(root, videoPath)) return null;
  const size = (await stat(videoPath)).size;
  const tools = await ffprobe();
  const probe = tools ? await probeMedia(tools, videoPath).catch(() => null) : null;
  const videoSha = typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/i.test(raw.sha256) ? raw.sha256.toLowerCase() : null;
  const publishAt = Date.parse(state.publishAtUtc);
  const slotDate = new Intl.DateTimeFormat("en-CA", { timeZone: state.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(publishAt));
  return {
    channelId,
    slotId: state.slotId,
    video: fp.video,
    manifestSha256: fp.manifestSha256,
    publishAt,
    slotDate,
    timeZone: state.timeZone,
    crossPost: raw.crossPost,
    videoFile: { path: videoPath, sizeBytes: size, durationSeconds: probe?.durationSeconds ?? null, width: probe?.video?.width ?? null, height: probe?.video?.height ?? null },
    videoSha256: videoSha,
    isAiGenerated: typeof raw.containsSyntheticMedia === "boolean" ? raw.containsSyntheticMedia : channelSynthetic,
  };
}

/**
 * BL-252 stage 2 (AC-XP-15): what the owner sees on «План недели» before approving a slot -- the networks, texts and problems of
 * the slot's package `crossPost` block, read from the manifest whose SHA-256 the screen shows (the one being approved). Read-only.
 */
export async function slotCrossPostPreview(channelId: string, video: string, manifestSha256: string): Promise<{ crossPost: unknown; videoSha256: string | null; durationSeconds: number | null; width: number | null; height: number | null; sizeBytes: number | null } | null> {
  const workspace = await createChannelWorkspacesCore().getWorkspace({ channelId });
  if (!workspace.configured) return null;
  const root = await realpath(workspace.path).catch(() => null);
  if (!root) return null;
  const scan = await createPackageScanCore().scan(channelId);
  if (scan.status !== "ok") return null;
  const scanned = scan.packages.find((p) => p.manifestSha256 === manifestSha256 && p.pkg?.video === video);
  if (!scanned) return null;
  const manifestPath = await realpath(path.join(root, ...scanned.manifestPath.split("/")));
  if (!isPathInsideOrEqual(root, manifestPath)) return null;
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > MANIFEST_MAX_BYTES || sha256Hex(bytes) !== manifestSha256) return null;
  const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  if (raw.crossPost === undefined || raw.crossPost === null) return { crossPost: null, videoSha256: null, durationSeconds: null, width: null, height: null, sizeBytes: null };
  const files = (raw.files ?? {}) as Record<string, unknown>;
  const videoPath = typeof files.video === "string" ? await realpath(path.join(path.dirname(manifestPath), files.video)).catch(() => null) : null;
  const inside = videoPath && isPathInsideOrEqual(root, videoPath) ? videoPath : null;
  const tools = inside ? await ffprobe() : null;
  const probe = tools && inside ? await probeMedia(tools, inside).catch(() => null) : null;
  return {
    crossPost: raw.crossPost,
    videoSha256: typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/i.test(raw.sha256) ? raw.sha256.toLowerCase() : null,
    durationSeconds: probe?.durationSeconds ?? null,
    width: probe?.video?.width ?? null,
    height: probe?.video?.height ?? null,
    sizeBytes: inside ? (await stat(inside)).size : null,
  };
}
