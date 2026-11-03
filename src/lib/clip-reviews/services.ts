import { parseWithSchema } from "@/lib/shared-domain";
import { CLIP_REVIEW_LIMITS, DomainError, type ClipFileState, type ClipReviewClip, type ClipReviewDecision, type ClipReviewsPorts, type ClipReviewView, type OwnerClipView, type ResolvedClipFile } from "./contracts";
import { clipVideoTypeOf, clipViewOf, durationAccepted, sortClipViews } from "./model";
import { getClipInputSchema, listClipsInputSchema, ownerClipDecisionInputSchema, submitClipInputSchema, withdrawClipInputSchema } from "./schemas";

// BL-241 (CLIP_REVIEWS_PLAN.md items 2-8, ADR 0061): what the Producer and the owner may do with a clip. The Producer submits,
// withdraws, lists and gets; the owner lists, plays and decides. The two surfaces are built separately (`producerSurface`,
// `ownerSurface`) so no MCP path can hold a decision function.

export function createClipReviewsService(ports: ClipReviewsPorts) {
  const stamp = () => ports.now().toISOString();

  async function assertChannel(channelId: string): Promise<void> {
    if (!(await ports.isChannelConnected(channelId))) {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "This channel is not connected on this computer -- producer_list_channels lists the channels you can use.", details: { channelId } });
    }
  }

  async function requireWorkspace(channelId: string): Promise<string> {
    const workspace = await ports.workspace(channelId);
    if (!workspace) throw new DomainError({ code: "clip_review_workspace_unavailable", message: "The channel has no workspace folder on this computer (Settings → Channels)", details: { channelId } });
    return workspace;
  }

  async function requireClip(channelId: string, clipId: string): Promise<{ clip: ClipReviewClip; decisions: ClipReviewDecision[] }> {
    const snapshot = await ports.store.read(channelId);
    const clip = snapshot.clips[clipId];
    if (!clip || clip.channelId !== channelId) throw new DomainError({ code: "clip_review_not_found", message: `No clip ${clipId} in this channel`, details: { channelId, clipId } });
    return { clip, decisions: Object.values(snapshot.decisions) };
  }

  function notPending(view: ClipReviewView): DomainError {
    return new DomainError({ code: "clip_review_not_pending", message: `Clip ${view.clipId} is ${view.status}, not pending`, details: { clipId: view.clipId, status: view.status } });
  }

  /** This computer's copy of a clip, resolved by the shared workspace rule; null when it is not here (or not allowed). */
  async function localFile(clip: ClipReviewClip): Promise<ResolvedClipFile | null> {
    const workspace = await ports.workspace(clip.channelId);
    if (!workspace || !clipVideoTypeOf(clip.clipPath)) return null;
    const resolved = await ports.resolveFile(workspace, clip.clipPath).catch(() => null);
    return resolved?.ok ? { path: resolved.path, bytes: resolved.bytes } : null;
  }

  /** Missing here, the submitted file, or another one (size first; the hash when `deep`). */
  async function fileStateOf(clip: ClipReviewClip, deep: boolean): Promise<ClipFileState> {
    const file = await localFile(clip);
    if (!file) return "missing";
    if (file.bytes !== clip.sizeBytes) return "changed";
    if (!deep) return "ok";
    const sha = await ports.hashFile(file.path).catch(() => null);
    if (sha === null) return "missing";
    return sha === clip.sha256 ? "ok" : "changed";
  }

  async function views(channelId: string): Promise<ClipReviewView[]> {
    const snapshot = await ports.store.read(channelId);
    const decisions = Object.values(snapshot.decisions);
    return sortClipViews(Object.values(snapshot.clips).filter((c) => c.channelId === channelId).map((clip) => clipViewOf(clip, decisions)));
  }

  /** `producer_clip_review_submit`: every rule is checked first; a refusal stores nothing. */
  async function submit(input: unknown, producer: { tokenId: string }): Promise<{ clip: ClipReviewView }> {
    const parsed = parseWithSchema(submitClipInputSchema, input, "clip review");
    const { channelId, clipPath } = parsed;
    await ports.assertDeviceAvailable();
    await assertChannel(channelId);
    const workspace = await requireWorkspace(channelId);
    if (!clipVideoTypeOf(clipPath)) {
      throw new DomainError({ code: "clip_review_not_video", message: "A clip is an .mp4, .mov or .webm file", details: { clipPath } });
    }
    const resolved = await ports.resolveFile(workspace, clipPath);
    if (!resolved.ok) throw new DomainError({ code: "clip_review_file_unavailable", message: `The clip file cannot be used: ${resolved.reason}`, details: { clipPath, reason: resolved.reason } });
    const duration = await ports.probeDurationSeconds(resolved.path);
    if (duration === null) {
      throw new DomainError({ code: "clip_review_probe_unavailable", message: "The clip's duration could not be measured on this computer (ffprobe missing or the file unreadable)", details: { clipPath } });
    }
    if (!durationAccepted(duration, CLIP_REVIEW_LIMITS)) {
      throw new DomainError({
        code: "clip_review_duration_out_of_range",
        message: `A clip is ${CLIP_REVIEW_LIMITS.minSeconds}-${CLIP_REVIEW_LIMITS.maxSeconds} s long; this one is ${duration.toFixed(1)} s`,
        details: { clipPath, durationSeconds: duration },
      });
    }
    const startSec = parsed.startSec ?? null;
    const endSec = parsed.endSec ?? null;
    if ((startSec !== null && startSec >= (endSec ?? duration)) || (endSec !== null && (endSec > duration || endSec <= 0))) {
      throw new DomainError({ code: "validation_failed", message: `The time range must lie within the clip (0 <= startSec < endSec <= ${duration.toFixed(1)})`, details: { startSec, endSec, durationSeconds: duration } });
    }
    const sha256 = await ports.hashFile(resolved.path);
    return ports.withLock(async () => {
      const current = await views(channelId);
      const pending = current.filter((v) => v.status === "pending");
      const duplicate = pending.find((v) => v.clipPath === clipPath);
      if (duplicate) throw new DomainError({ code: "clip_review_duplicate", message: `This file is already waiting for the owner as clip ${duplicate.clipId}`, details: { clipId: duplicate.clipId } });
      if (pending.length >= CLIP_REVIEW_LIMITS.pending) {
        throw new DomainError({ code: "clip_review_too_many_pending", message: `At most ${CLIP_REVIEW_LIMITS.pending} clips of a channel wait for the owner at once`, details: { pending: pending.length } });
      }
      const clip: ClipReviewClip = {
        clipId: `clip_${ports.randomId()}`.slice(0, 40),
        channelId,
        sceneId: parsed.sceneId,
        clipPath,
        note: parsed.note,
        startSec,
        endSec,
        durationSeconds: Math.round(duration * 1000) / 1000,
        sizeBytes: resolved.bytes,
        sha256,
        submittedAt: stamp(),
        submittedBy: producer.tokenId,
        device: await ports.deviceLabel(),
      };
      await ports.store.addClip(channelId, clip);
      return { clip: clipViewOf(clip, []) };
    });
  }

  /** `producer_clip_review_withdraw`: a pending clip leaves the queue. */
  async function withdraw(input: unknown): Promise<{ clip: ClipReviewView }> {
    const { channelId, clipId } = parseWithSchema(withdrawClipInputSchema, input, "clip review");
    await ports.assertDeviceAvailable();
    await assertChannel(channelId);
    return ports.withLock(async () => {
      const { clip, decisions } = await requireClip(channelId, clipId);
      const view = clipViewOf(clip, decisions);
      if (view.status !== "pending") throw notPending(view);
      const record: ClipReviewDecision = { id: `cd_${ports.randomId()}`.slice(0, 40), clipId, kind: "withdrawn", by: "producer", comment: null, device: await ports.deviceLabel(), at: stamp() };
      await ports.store.addDecision(channelId, record);
      return { clip: clipViewOf(clip, [...decisions, record]) };
    });
  }

  async function get(input: unknown): Promise<{ clip: ClipReviewView }> {
    const { channelId, clipId } = parseWithSchema(getClipInputSchema, input, "clip review");
    await assertChannel(channelId);
    const { clip, decisions } = await requireClip(channelId, clipId);
    return { clip: clipViewOf(clip, decisions) };
  }

  async function list(input: unknown): Promise<{ clips: ClipReviewView[]; pending: number }> {
    const { channelId, status, limit } = parseWithSchema(listClipsInputSchema, input, "clip reviews");
    await assertChannel(channelId);
    const all = await views(channelId);
    const pending = all.filter((v) => v.status === "pending").length;
    return { clips: all.filter((v) => !status || v.status === status).slice(0, limit ?? CLIP_REVIEW_LIMITS.listDefault), pending };
  }

  /** The owner's list: every clip of the channel with this computer's copy (the pending ones hashed), and how many wait. */
  async function ownerList(channelId: string): Promise<{ clips: OwnerClipView[]; waiting: number }> {
    const snapshot = await ports.store.read(channelId);
    const all = await views(channelId);
    const clips: OwnerClipView[] = [];
    for (const view of all) clips.push({ ...view, file: await fileStateOf(snapshot.clips[view.clipId], view.status === "pending") });
    return { clips, waiting: all.filter((v) => v.status === "pending").length };
  }

  /**
   * The owner's decision (Web UI only, ADR 0061 §4): the clip must be pending on this computer; approval also needs this computer's
   * file to be the submitted one (size and SHA-256). A refusal writes nothing.
   */
  async function decide(channelId: string, clipId: string, input: unknown, userId: string): Promise<{ clip: OwnerClipView }> {
    const parsed = parseWithSchema(ownerClipDecisionInputSchema, input, "clip decision");
    return ports.withLock(async () => {
      const { clip, decisions } = await requireClip(channelId, clipId);
      const view = clipViewOf(clip, decisions);
      if (view.status !== "pending") throw notPending(view);
      const file = await fileStateOf(clip, true);
      if (parsed.action === "approve" && file === "missing") {
        throw new DomainError({ code: "clip_review_file_missing", message: "The clip's file is not on this computer: it cannot be approved unseen", details: { clipId } });
      }
      if (parsed.action === "approve" && file === "changed") {
        throw new DomainError({ code: "clip_review_file_changed", message: "The clip's file on this computer is not the one the Producer submitted", details: { clipId } });
      }
      const comment = (parsed.comment ?? "").trim() || null;
      const kind = parsed.action === "approve" ? "approved" : "returned";
      const device = await ports.deviceLabel();
      const at = stamp();
      const record: ClipReviewDecision = { id: `cd_${ports.randomId()}`.slice(0, 40), clipId, kind, by: "owner", comment, device, at };
      await ports.store.addDecision(channelId, record);
      await ports.audit({ channelId, clipId, detail: { event: `clip_review.${kind}`, at, decisionId: record.id, clipId, sceneId: clip.sceneId, clipPath: clip.clipPath, sha256: clip.sha256, comment, by: userId, device } });
      return { clip: { ...clipViewOf(clip, [...decisions, record]), file } };
    });
  }

  /** The clip's file on this computer for the player (the shared workspace rule again), with its type; null when not here. */
  async function clipFile(channelId: string, clipId: string): Promise<(ResolvedClipFile & { type: string }) | null> {
    const { clip } = await requireClip(channelId, clipId);
    const file = await localFile(clip);
    const type = file ? clipVideoTypeOf(file.path) : null;
    return file && type ? { ...file, type } : null;
  }

  return { submit, withdraw, get, list, ownerList, decide, clipFile };
}

export type ClipReviewsService = ReturnType<typeof createClipReviewsService>;

/** What the Producer gets (MCP): submit, withdraw, list, get -- never a decision (ADR 0061 §2, AC-CR-12). */
export type ClipReviewsProducerSurface = Pick<ClipReviewsService, "submit" | "withdraw" | "list" | "get">;
export function producerSurface(service: ClipReviewsProducerSurface): ClipReviewsProducerSurface {
  return { submit: (input, producer) => service.submit(input, producer), withdraw: (input) => service.withdraw(input), list: (input) => service.list(input), get: (input) => service.get(input) };
}

/** What the owner's Web UI routes get: the list, the decision, the file to play. */
export type ClipReviewsOwnerSurface = Pick<ClipReviewsService, "ownerList" | "decide" | "clipFile">;
export function ownerSurface(service: ClipReviewsOwnerSurface): ClipReviewsOwnerSurface {
  return { ownerList: (channelId) => service.ownerList(channelId), decide: (channelId, clipId, input, userId) => service.decide(channelId, clipId, input, userId), clipFile: (channelId, clipId) => service.clipFile(channelId, clipId) };
}
