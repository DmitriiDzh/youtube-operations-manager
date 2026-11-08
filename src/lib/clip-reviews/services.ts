import { parseWithSchema, type DomainErrorCode } from "@/lib/shared-domain";
import { attachmentRefusalOf, attachmentRuleOf, CLIP_ATTACHMENT_LIMITS, headMatchesKind, sanitizeAttachmentName, textLooksValid, uniqueAttachmentNames } from "./attachments";
import {
  CLIP_ATTACHMENTS_FOLDER,
  CLIP_REVIEW_LIMITS,
  DomainError,
  type ClipFileState,
  type ClipReviewAttachment,
  type ClipReviewClip,
  type ClipReviewDecision,
  type ClipReviewsPorts,
  type ClipReviewView,
  type OwnerAttachmentView,
  type OwnerClipView,
  type ResolvedClipFile,
  type StagedAttachment,
} from "./contracts";
import { clipVideoTypeOf, clipViewOf, decidingRecordOf, durationAccepted, sortClipViews, wellFormedAttachments } from "./model";
import { getClipInputSchema, listClipsInputSchema, ownerClipDecisionInputSchema, stageAttachmentInputSchema, submitClipInputSchema, uploadIdSchema, withdrawClipInputSchema } from "./schemas";

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
      throw new DomainError({ code: "clip_review_not_video", message: "A clip is an .mp4 or .webm file", details: { clipPath } });
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

  /** BL-246: the deciding decision's attachments with this computer's copy, by size only (as the clips, AC-CR-08 / AC-CR-23). */
  async function ownerAttachmentsOf(clip: ClipReviewClip, decisionId: string | null, attachments: readonly ClipReviewAttachment[]): Promise<OwnerAttachmentView[]> {
    if (!decisionId || attachments.length === 0) return [];
    const workspace = await ports.workspace(clip.channelId);
    const out: OwnerAttachmentView[] = [];
    for (const [index, attachment] of attachments.entries()) {
      let file: ClipFileState = "missing";
      if (workspace && attachment.path === attachmentPathOf(clip.clipId, decisionId, attachment.name)) {
        const found = await ports.attachmentFiles.resolve(workspace, clip.clipId, decisionId, attachment.name).catch(() => null);
        file = !found ? "missing" : found.bytes === attachment.size ? "ok" : "changed";
      }
      out.push({ ...attachment, index, file });
    }
    return out;
  }

  /** The owner's list: every clip of the channel with this computer's copy, and how many scenes wait (BL-247, AC-CR-31: a scene
   *  with at least one pending version counts once). */
  async function ownerList(channelId: string): Promise<{ clips: OwnerClipView[]; waiting: number }> {
    const snapshot = await ports.store.read(channelId);
    const all = await views(channelId);
    const decisions = Object.values(snapshot.decisions);
    const clips: OwnerClipView[] = [];
    // Review: the list (and the 60 s tab badge) checks the size only -- hashing ~100 MB clips on every poll is too costly; the
    // SHA-256 is checked where it matters, when the owner approves (`decide`).
    for (const view of all) {
      const clip = snapshot.clips[view.clipId];
      const record = decidingRecordOf(view.clipId, decisions);
      const decisionId = record?.id ?? null;
      clips.push({ ...view, file: await fileStateOf(clip, false), decisionId, attachments: await ownerAttachmentsOf(clip, decisionId, view.attachments) });
    }
    return { clips, waiting: new Set(all.filter((v) => v.status === "pending").map((v) => v.sceneId)).size };
  }

  // ---- BL-246 (ADR 0065, CLIP_REVIEWS_PLAN.md items 10-16): the owner's comment attachments ----

  const attachmentError = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

  /** A pending clip of this channel (stage and pieces are only for a decision still to be made). */
  async function requirePendingClip(channelId: string, clipId: string): Promise<ClipReviewClip> {
    const { clip, decisions } = await requireClip(channelId, clipId);
    const view = clipViewOf(clip, decisions);
    if (view.status !== "pending") throw notPending(view);
    return clip;
  }

  /** The staged upload of exactly this clip of this channel. */
  async function requireStaged(channelId: string, clipId: string, uploadId: unknown) {
    const id = uploadIdSchema.safeParse(uploadId);
    const staged = id.success ? await ports.staging.get(id.data) : null;
    if (!staged || staged.upload.channelId !== channelId || staged.upload.clipId !== clipId) {
      throw attachmentError("clip_attachment_upload_unknown", "No such upload for this clip on this computer (send the file again)", { uploadId: id.success ? id.data : null });
    }
    return staged;
  }

  /** The whole staged file is its extension's kind and the browser's SHA-256 (item 11, item 13). */
  async function verifyStaged(upload: StagedAttachment): Promise<void> {
    const rule = attachmentRuleOf(upload.rawName);
    let kindOk = false;
    if (rule) {
      kindOk = headMatchesKind(upload.rawName, await ports.staging.head(upload.uploadId, 64));
      if (kindOk && (rule.kind === "text" || rule.kind === "json")) kindOk = textLooksValid(await ports.staging.readAll(upload.uploadId), rule.kind === "json");
    }
    if (!kindOk) throw attachmentError("clip_attachment_type_mismatch", `${upload.rawName || "The file"} is not the kind its name says`, { uploadId: upload.uploadId });
    if ((await ports.staging.hash(upload.uploadId)) !== upload.sha256) {
      throw attachmentError("clip_attachment_upload_corrupt", "The file arrived different from what the browser sent (send it again)", { uploadId: upload.uploadId });
    }
  }

  /** Stages one file for the owner's next decision on a pending clip; its pieces follow (`appendAttachmentPiece`). */
  async function stageAttachment(channelId: string, clipId: string, input: unknown): Promise<{ uploadId: string; name: string; mime: string }> {
    const parsed = parseWithSchema(stageAttachmentInputSchema, input, "clip attachment");
    await requirePendingClip(channelId, clipId);
    const refusal = attachmentRefusalOf(parsed);
    if (refusal === "type_not_allowed") {
      throw attachmentError("clip_attachment_type_not_allowed", "Only png, jpg, webp, gif, pdf, txt, md, json, mp4, webm or mov files can be attached", { name: parsed.name });
    }
    if (refusal === "type_mismatch") throw attachmentError("clip_attachment_type_mismatch", `The file's type (${parsed.type}) is not its extension's`, { name: parsed.name, type: parsed.type });
    if (refusal === "too_large") throw attachmentError("clip_attachment_too_large", `A file is at most ${CLIP_ATTACHMENT_LIMITS.bytes} bytes (50 MiB)`, { size: parsed.size, max: CLIP_ATTACHMENT_LIMITS.bytes });
    if (refusal === "empty") throw attachmentError("validation_failed", "An empty file cannot be attached", { size: parsed.size });
    // Abandoned comments do not pile up: older uploads are removed whenever a new one starts.
    await ports.staging.removeOlderThan(new Date(ports.now().getTime() - CLIP_ATTACHMENT_LIMITS.stagedHours * 3_600_000)).catch(() => undefined);
    const uploadId = Array.from({ length: 2 }, () => ports.randomId()).join("").replace(/[^a-f0-9]/g, "").padEnd(32, "0").slice(0, 32);
    const upload: StagedAttachment = { uploadId, channelId, clipId, rawName: parsed.name, declaredType: parsed.type, size: parsed.size, sha256: parsed.sha256, createdAt: stamp() };
    await ports.staging.create(upload);
    return { uploadId, name: sanitizeAttachmentName(parsed.name, 1), mime: attachmentRuleOf(parsed.name)!.mime };
  }

  /** The next piece of a staged file at `offset` (exactly the bytes received so far); the last one checks the kind and the SHA-256. */
  async function appendAttachmentPiece(channelId: string, clipId: string, uploadId: string, offset: number, bytes: Uint8Array): Promise<{ received: number; complete: boolean }> {
    await requireClip(channelId, clipId);
    if (bytes.length === 0 || bytes.length > CLIP_ATTACHMENT_LIMITS.pieceBytes) {
      throw attachmentError("validation_failed", `A piece is 1..${CLIP_ATTACHMENT_LIMITS.pieceBytes} bytes`, { bytes: bytes.length });
    }
    return ports.withLock(async () => {
      const staged = await requireStaged(channelId, clipId, uploadId);
      if (!Number.isSafeInteger(offset) || offset !== staged.received || staged.received + bytes.length > staged.upload.size) {
        throw attachmentError("clip_attachment_upload_offset", "This piece does not continue the file", { offset, received: staged.received, size: staged.upload.size });
      }
      const received = await ports.staging.append(staged.upload.uploadId, bytes);
      const complete = received === staged.upload.size;
      if (complete) {
        try {
          await verifyStaged(staged.upload);
        } catch (error) {
          await ports.staging.remove(staged.upload.uploadId).catch(() => undefined);
          throw error;
        }
      }
      return { received, complete };
    });
  }

  /** The owner removed a chip (×): its staged file is dropped. */
  async function discardAttachment(channelId: string, clipId: string, uploadId: string): Promise<{ removed: true }> {
    await requireClip(channelId, clipId);
    // Under the lock (review): never in the middle of a piece being appended or a decision copying this file.
    return ports.withLock(async () => {
      const staged = await requireStaged(channelId, clipId, uploadId);
      await ports.staging.remove(staged.upload.uploadId);
      return { removed: true as const };
    });
  }

  /**
   * BL-246 (review): staged uploads that can no longer be used -- idle for 24 h (the upload as a whole), a stray file, or one whose
   * clip is not pending any more (answered, withdrawn, or gone). Run once when the server starts. Never touches the channel folder.
   */
  async function sweepStaged(): Promise<{ removed: number }> {
    const cutoff = ports.now().getTime() - CLIP_ATTACHMENT_LIMITS.stagedHours * 3_600_000;
    let removed = 0;
    const snapshots = new Map<string, Awaited<ReturnType<typeof ports.store.read>>>();
    for (const entry of await ports.staging.list()) {
      let drop = !entry.upload || entry.lastActivity.getTime() < cutoff;
      if (!drop && entry.upload) {
        const { channelId, clipId } = entry.upload;
        if (!snapshots.has(channelId)) snapshots.set(channelId, await ports.store.read(channelId));
        const snapshot = snapshots.get(channelId)!;
        const clip = Object.hasOwn(snapshot.clips, clipId) ? snapshot.clips[clipId] : undefined;
        drop = !clip || clipViewOf(clip, Object.values(snapshot.decisions)).status !== "pending";
      }
      if (drop) {
        await ports.withLock(() => ports.staging.remove(entry.uploadId)).catch(() => undefined);
        removed++;
      }
    }
    return { removed };
  }

  /**
   * BL-246: one attachment of a decision on this clip, from this computer's copy, for the owner's screen. The stored path must be
   * exactly that decision's folder plus its name; it is resolved again by the shared rule; a file not here yet is
   * `clip_attachment_missing`, a different one (size or SHA-256) `clip_attachment_changed` -- never served.
   */
  async function attachmentFile(channelId: string, clipId: string, decisionId: string, index: number): Promise<ResolvedClipFile & { type: string; name: string }> {
    await requireClip(channelId, clipId);
    const snapshot = await ports.store.read(channelId);
    const decision = Object.hasOwn(snapshot.decisions, decisionId) ? snapshot.decisions[decisionId] : undefined;
    // The same list (and so the same places) as the owner's screen: malformed entries skipped (review).
    const attachment = decision && decision.clipId === clipId && decision.by === "owner" && Number.isSafeInteger(index) && index >= 0 ? wellFormedAttachments(decision.attachments)[index] : undefined;
    const rule = attachment ? attachmentRuleOf(attachment.name) : null;
    const notFound = () => attachmentError("clip_attachment_not_found", "No such attachment of this clip", { clipId, decisionId, index });
    if (!attachment || !rule || attachment.path !== attachmentPathOf(clipId, decisionId, attachment.name)) throw notFound();
    const workspace = await requireWorkspace(channelId);
    let file: ResolvedClipFile | null;
    try {
      file = await ports.attachmentFiles.resolve(workspace, clipId, decisionId, attachment.name);
    } catch {
      throw notFound();
    }
    if (!file) throw attachmentError("clip_attachment_missing", "This file has not arrived on this computer yet", { clipId, decisionId, index });
    if (file.bytes !== attachment.size || (await ports.hashFile(file.path)) !== attachment.sha256) {
      throw attachmentError("clip_attachment_changed", "This file on this computer is not the one attached", { clipId, decisionId, index });
    }
    return { ...file, type: rule.kind === "text" || rule.kind === "json" ? "text/plain; charset=utf-8" : rule.mime, name: attachment.name };
  }

  /**
   * The owner's decision (Web UI only, ADR 0061 §4): the clip must be pending on this computer; approval also needs this computer's
   * file to be the submitted one (size and SHA-256). A refusal writes nothing.
   *
   * BL-246 (ADR 0065 §4): with attachments, everything is checked before the workspace is touched; then the files are written into
   * the decision's folder and only then is the decision recorded. A failed write or record leaves no folder and no decision.
   */
  async function decide(channelId: string, clipId: string, input: unknown, userId: string): Promise<{ clip: OwnerClipView }> {
    const parsed = parseWithSchema(ownerClipDecisionInputSchema, input, "clip decision");
    const uploadIds = parsed.attachments ?? [];
    if (uploadIds.length > CLIP_ATTACHMENT_LIMITS.files) {
      throw attachmentError("clip_attachment_too_many", `At most ${CLIP_ATTACHMENT_LIMITS.files} files per decision`, { count: uploadIds.length, max: CLIP_ATTACHMENT_LIMITS.files });
    }
    if (new Set(uploadIds).size !== uploadIds.length) throw attachmentError("validation_failed", "The same upload is attached twice", {});
    await requireClip(channelId, clipId);
    const staged: Array<{ upload: StagedAttachment; path: string }> = [];
    for (const uploadId of uploadIds) {
      const one = await requireStaged(channelId, clipId, uploadId);
      if (one.received !== one.upload.size) {
        throw attachmentError("clip_attachment_upload_incomplete", "A file has not finished uploading", { uploadId, received: one.received, size: one.upload.size });
      }
      await verifyStaged(one.upload);
      staged.push(one);
    }
    const names = uniqueAttachmentNames(staged.map((one, i) => sanitizeAttachmentName(one.upload.rawName, i + 1)));
    return ports.withLock(async () => {
      const { clip, decisions } = await requireClip(channelId, clipId);
      const view = clipViewOf(clip, decisions);
      if (view.status !== "pending") {
        // The clip was answered meanwhile (perhaps on the other computer): these files can never be used, so they go now (review).
        for (const one of staged) await ports.staging.remove(one.upload.uploadId).catch(() => undefined);
        throw notPending(view);
      }
      const file = await fileStateOf(clip, true);
      if (parsed.action === "approve" && file === "missing") {
        throw new DomainError({ code: "clip_review_file_missing", message: "The clip's file is not on this computer: it cannot be approved unseen", details: { clipId } });
      }
      if (parsed.action === "approve" && file === "changed") {
        throw new DomainError({ code: "clip_review_file_changed", message: "The clip's file on this computer is not the one the Producer submitted", details: { clipId } });
      }
      const workspace = staged.length > 0 ? await requireWorkspace(channelId) : null;
      const comment = (parsed.comment ?? "").trim() || null;
      const kind = parsed.action === "approve" ? "approved" : "returned";
      const device = await ports.deviceLabel();
      const at = stamp();
      const id = `cd_${ports.randomId()}`.slice(0, 40);
      const attachments: ClipReviewAttachment[] = staged.map((one, i) => ({
        path: attachmentPathOf(clipId, id, names[i]),
        name: names[i],
        mime: attachmentRuleOf(one.upload.rawName)!.mime,
        size: one.upload.size,
        sha256: one.upload.sha256,
      }));
      if (workspace) {
        try {
          await ports.attachmentFiles.write(
            workspace,
            clipId,
            id,
            staged.map((one, i) => ({ sourcePath: one.path, name: names[i], size: one.upload.size, sha256: one.upload.sha256 }))
          );
        } catch (error) {
          // The fs error names absolute paths: it goes to this computer's log, never to the browser (review).
          ports.logError("clip_review.attachments_write_failed", { channelId, clipId, decisionId: id, reason: error instanceof Error ? error.message : String(error) });
          throw attachmentError("clip_attachment_write_failed", "The files could not be written into the channel folder on this computer", { clipId });
        }
      }
      const record: ClipReviewDecision = { id, clipId, kind, by: "owner", comment, device, at, ...(attachments.length > 0 ? { attachments } : {}) };
      try {
        await ports.store.addDecision(channelId, record);
      } catch (error) {
        // All or nothing (item 14): the decision was not recorded, so its files must not stay in the channel folder.
        if (workspace) await ports.attachmentFiles.remove(workspace, clipId, id).catch(() => undefined);
        throw error;
      }
      for (const one of staged) await ports.staging.remove(one.upload.uploadId).catch(() => undefined);
      await ports.audit({
        channelId,
        clipId,
        detail: { event: `clip_review.${kind}`, at, decisionId: record.id, clipId, sceneId: clip.sceneId, clipPath: clip.clipPath, sha256: clip.sha256, comment, by: userId, device, attachments: attachments.map((a) => ({ path: a.path, size: a.size, sha256: a.sha256 })) },
      });
      // BL-248 (ADR 0066): the Producer's Inbox writer runs soon; it never throws and never holds the decision.
      ports.notifyOwnerDecision?.();
      const decided = clipViewOf(clip, [...decisions, record]);
      return { clip: { ...decided, file, decisionId: id, attachments: attachments.map((a, index) => ({ ...a, index, file: "ok" as const })) } };
    });
  }

  /** The clip's file on this computer for the player (the shared workspace rule again), with its type; null when not here. */
  async function clipFile(channelId: string, clipId: string): Promise<(ResolvedClipFile & { type: string }) | null> {
    const { clip } = await requireClip(channelId, clipId);
    const file = await localFile(clip);
    const type = file ? clipVideoTypeOf(file.path) : null;
    return file && type ? { ...file, type } : null;
  }

  return { submit, withdraw, get, list, ownerList, decide, clipFile, stageAttachment, appendAttachmentPiece, discardAttachment, attachmentFile, sweepStaged };
}

/** BL-246: where an attachment of a decision lives, relative to the workspace (`/` between folders). */
export function attachmentPathOf(clipId: string, decisionId: string, name: string): string {
  return `${CLIP_ATTACHMENTS_FOLDER}/${clipId}/${decisionId}/${name}`;
}

export type ClipReviewsService = ReturnType<typeof createClipReviewsService>;

/** What the Producer gets (MCP): submit, withdraw, list, get -- never a decision (ADR 0061 §2, AC-CR-12). */
export type ClipReviewsProducerSurface = Pick<ClipReviewsService, "submit" | "withdraw" | "list" | "get">;
export function producerSurface(service: ClipReviewsProducerSurface): ClipReviewsProducerSurface {
  return { submit: (input, producer) => service.submit(input, producer), withdraw: (input) => service.withdraw(input), list: (input) => service.list(input), get: (input) => service.get(input) };
}

/** What the owner's Web UI routes get: the list, the decision, the file to play; since BL-246 the attachments' staging and serving. */
export type ClipReviewsOwnerSurface = Pick<ClipReviewsService, "ownerList" | "decide" | "clipFile" | "stageAttachment" | "appendAttachmentPiece" | "discardAttachment" | "attachmentFile">;
export function ownerSurface(service: ClipReviewsOwnerSurface): ClipReviewsOwnerSurface {
  return {
    ownerList: (channelId) => service.ownerList(channelId),
    decide: (channelId, clipId, input, userId) => service.decide(channelId, clipId, input, userId),
    clipFile: (channelId, clipId) => service.clipFile(channelId, clipId),
    stageAttachment: (channelId, clipId, input) => service.stageAttachment(channelId, clipId, input),
    appendAttachmentPiece: (channelId, clipId, uploadId, offset, bytes) => service.appendAttachmentPiece(channelId, clipId, uploadId, offset, bytes),
    discardAttachment: (channelId, clipId, uploadId) => service.discardAttachment(channelId, clipId, uploadId),
    attachmentFile: (channelId, clipId, decisionId, index) => service.attachmentFile(channelId, clipId, decisionId, index),
  };
}
