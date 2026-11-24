import { parseWithSchema } from "@/lib/shared-domain";
import { DomainError, IMAGE_REVIEW_LIMITS, type ImageFileState, type ImageReviewDecision, type ImageReviewImage, type ImageReviewsPorts, type ImageReviewView, type OwnerImageView, type ResolvedImageFile } from "./contracts";
import { imageFileTypeOf, imageViewOf, sortImageViews } from "./model";
import { getImageInputSchema, listImagesInputSchema, ownerImageDecisionInputSchema, submitImageInputSchema, withdrawImageInputSchema } from "./schemas";

// BL-272 (ADR 0076): what the Producer and the owner may do with a master still image. The Producer submits, withdraws, lists and
// gets; the owner lists, looks and decides. The two surfaces are built separately (`producerSurface`, `ownerSurface`) so no MCP path
// can hold a decision function (the clip-reviews pattern, ADR 0061 §2/§4).

export function createImageReviewsService(ports: ImageReviewsPorts) {
  const stamp = () => ports.now().toISOString();

  async function assertChannel(channelId: string): Promise<void> {
    if (!(await ports.isChannelConnected(channelId))) {
      throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "This channel is not connected on this computer -- producer_list_channels lists the channels you can use.", details: { channelId } });
    }
  }

  async function requireWorkspace(channelId: string): Promise<string> {
    const workspace = await ports.workspace(channelId);
    if (!workspace) throw new DomainError({ code: "image_review_workspace_unavailable", message: "The channel has no workspace folder on this computer (Settings → Channels)", details: { channelId } });
    return workspace;
  }

  async function requireImage(channelId: string, imageId: string): Promise<{ image: ImageReviewImage; decisions: ImageReviewDecision[] }> {
    const snapshot = await ports.store.read(channelId);
    const image = Object.hasOwn(snapshot.images, imageId) ? snapshot.images[imageId] : undefined;
    if (!image || image.channelId !== channelId) throw new DomainError({ code: "image_review_not_found", message: `No image ${imageId} in this channel`, details: { channelId, imageId } });
    return { image, decisions: Object.values(snapshot.decisions) };
  }

  function notPending(view: ImageReviewView): DomainError {
    return new DomainError({ code: "image_review_not_pending", message: `Image ${view.imageId} is ${view.status}, not pending`, details: { imageId: view.imageId, status: view.status } });
  }

  /** This computer's copy of an image, resolved by the shared workspace rule; null when it is not here (or not allowed). */
  async function localFile(image: ImageReviewImage): Promise<ResolvedImageFile | null> {
    const workspace = await ports.workspace(image.channelId);
    if (!workspace || !imageFileTypeOf(image.imagePath)) return null;
    const resolved = await ports.resolveFile(workspace, image.imagePath).catch(() => null);
    return resolved?.ok ? { path: resolved.path, bytes: resolved.bytes } : null;
  }

  /** Missing here, the submitted file, or another one (size, then the SHA-256 -- cached per size and time, a still is small). */
  async function fileStateOf(image: ImageReviewImage): Promise<ImageFileState> {
    const file = await localFile(image);
    if (!file) return "missing";
    if (file.bytes !== image.sizeBytes) return "changed";
    const sha = await ports.hashFile(file.path).catch(() => null);
    if (sha === null) return "missing";
    return sha === image.sha256 ? "ok" : "changed";
  }

  async function views(channelId: string): Promise<ImageReviewView[]> {
    const snapshot = await ports.store.read(channelId);
    const decisions = Object.values(snapshot.decisions);
    return sortImageViews(Object.values(snapshot.images).filter((i) => i.channelId === channelId).map((image) => imageViewOf(image, decisions)));
  }

  /**
   * `producer_image_review_submit`. Idempotent by `requestId`: a known one with the same request answers the stored image
   * (`replayed: true`) -- even when the file changed since or the owner already answered; with a different request it is refused.
   * Every other rule is checked first; a refusal stores nothing.
   */
  async function submit(input: unknown, producer: { tokenId: string }): Promise<{ image: ImageReviewView; replayed: boolean }> {
    const parsed = parseWithSchema(submitImageInputSchema, input, "image review");
    const { channelId, imagePath } = parsed;
    const note = parsed.note ?? "";
    const batchId = parsed.batchId ?? null;
    const requestId = parsed.requestId ?? null;
    await ports.assertDeviceAvailable();
    await assertChannel(channelId);
    return ports.withLock(async () => {
      const snapshot = await ports.store.read(channelId);
      const decisions = Object.values(snapshot.decisions);
      const images = Object.values(snapshot.images).filter((i) => i.channelId === channelId);
      if (requestId !== null) {
        const known = images.find((i) => i.requestId === requestId);
        if (known) {
          if (known.sceneId !== parsed.sceneId || known.imagePath !== imagePath || known.note !== note || known.batchId !== batchId) {
            throw new DomainError({ code: "image_review_request_conflict", message: `requestId ${requestId} was already used for another submit (image ${known.imageId})`, details: { requestId, imageId: known.imageId } });
          }
          return { image: imageViewOf(known, decisions), replayed: true };
        }
      }
      const workspace = await requireWorkspace(channelId);
      const kind = imageFileTypeOf(imagePath);
      if (!kind) throw new DomainError({ code: "image_review_not_image", message: "An image for review is a .png, .jpg or .jpeg file", details: { imagePath } });
      const resolved = await ports.resolveFile(workspace, imagePath);
      if (!resolved.ok) throw new DomainError({ code: "image_review_file_unavailable", message: `The image file cannot be used: ${resolved.reason}`, details: { imagePath, reason: resolved.reason } });
      if (resolved.bytes > IMAGE_REVIEW_LIMITS.maxBytes) {
        throw new DomainError({ code: "image_review_not_image", message: `An image for review is at most ${IMAGE_REVIEW_LIMITS.maxBytes} bytes`, details: { imagePath, sizeBytes: resolved.bytes } });
      }
      const info = await ports.probeImage(resolved.path);
      if (!info || info.format !== kind.format) {
        throw new DomainError({ code: "image_review_not_image", message: `The file is not a ${kind.format.toUpperCase()} image this computer can read`, details: { imagePath, format: info?.format ?? null } });
      }
      const sideOk = (side: number) => Number.isSafeInteger(side) && side >= IMAGE_REVIEW_LIMITS.minSide && side <= IMAGE_REVIEW_LIMITS.maxSide;
      if (!sideOk(info.width) || !sideOk(info.height)) {
        throw new DomainError({ code: "image_review_not_image", message: `An image is ${IMAGE_REVIEW_LIMITS.minSide}-${IMAGE_REVIEW_LIMITS.maxSide} px on each side`, details: { imagePath, width: info.width, height: info.height } });
      }
      const sha256 = await ports.hashFile(resolved.path);
      const current = images.map((image) => imageViewOf(image, decisions));
      const pending = current.filter((v) => v.status === "pending");
      const duplicate = pending.find((v) => v.imagePath === imagePath);
      if (duplicate) throw new DomainError({ code: "image_review_duplicate", message: `This file is already waiting for the owner as image ${duplicate.imageId}`, details: { imageId: duplicate.imageId } });
      if (pending.length >= IMAGE_REVIEW_LIMITS.pending) {
        throw new DomainError({ code: "image_review_too_many_pending", message: `At most ${IMAGE_REVIEW_LIMITS.pending} images of a channel wait for the owner at once`, details: { pending: pending.length } });
      }
      if (batchId !== null) {
        const inBatch = images.filter((i) => i.batchId === batchId).length;
        if (inBatch >= IMAGE_REVIEW_LIMITS.batch) {
          throw new DomainError({ code: "image_review_batch_full", message: `A batch holds at most ${IMAGE_REVIEW_LIMITS.batch} images (start a new batchId)`, details: { batchId, images: inBatch } });
        }
      }
      const image: ImageReviewImage = {
        imageId: `img_${ports.randomId()}`.slice(0, 40),
        channelId,
        sceneId: parsed.sceneId,
        imagePath,
        note,
        batchId,
        requestId,
        width: info.width,
        height: info.height,
        sizeBytes: resolved.bytes,
        sha256,
        submittedAt: stamp(),
        submittedBy: producer.tokenId,
        device: await ports.deviceLabel(),
      };
      await ports.store.addImage(channelId, image);
      return { image: imageViewOf(image, []), replayed: false };
    });
  }

  /** `producer_image_review_withdraw`: a pending image leaves the queue. */
  async function withdraw(input: unknown): Promise<{ image: ImageReviewView }> {
    const { channelId, imageId } = parseWithSchema(withdrawImageInputSchema, input, "image review");
    await ports.assertDeviceAvailable();
    await assertChannel(channelId);
    return ports.withLock(async () => {
      const { image, decisions } = await requireImage(channelId, imageId);
      const view = imageViewOf(image, decisions);
      if (view.status !== "pending") throw notPending(view);
      const record: ImageReviewDecision = { id: `id_${ports.randomId()}`.slice(0, 40), imageId, kind: "withdrawn", by: "producer", comment: null, device: await ports.deviceLabel(), at: stamp() };
      await ports.store.addDecision(channelId, record);
      return { image: imageViewOf(image, [...decisions, record]) };
    });
  }

  async function get(input: unknown): Promise<{ image: ImageReviewView }> {
    const { channelId, imageId } = parseWithSchema(getImageInputSchema, input, "image review");
    await assertChannel(channelId);
    const { image, decisions } = await requireImage(channelId, imageId);
    return { image: imageViewOf(image, decisions) };
  }

  async function list(input: unknown): Promise<{ images: ImageReviewView[]; pending: number }> {
    const { channelId, status, batchId, limit } = parseWithSchema(listImagesInputSchema, input, "image reviews");
    await assertChannel(channelId);
    const all = (await views(channelId)).filter((v) => !batchId || v.batchId === batchId);
    const pending = all.filter((v) => v.status === "pending").length;
    return { images: all.filter((v) => !status || v.status === status).slice(0, limit ?? IMAGE_REVIEW_LIMITS.listDefault), pending };
  }

  /**
   * The owner's list: every image of the channel and how many wait for him. This computer's copy (resolved, size, SHA-256) is checked
   * only for a pending image -- the only one he can approve; the rest are `file: null` (review: no file work for the history).
   */
  async function ownerList(channelId: string): Promise<{ images: OwnerImageView[]; waiting: number }> {
    const snapshot = await ports.store.read(channelId);
    const all = await views(channelId);
    const images: OwnerImageView[] = [];
    for (const view of all) images.push({ ...view, file: view.status === "pending" ? await fileStateOf(snapshot.images[view.imageId]) : null });
    return { images, waiting: all.filter((v) => v.status === "pending").length };
  }

  /** The badge: how many images wait for the owner -- the document only, no file work. */
  async function ownerWaiting(channelId: string): Promise<{ waiting: number }> {
    return { waiting: (await views(channelId)).filter((v) => v.status === "pending").length };
  }

  /**
   * The owner's decision (Web UI only): the image must be pending on this computer; an approval (with or without a note) also needs
   * this computer's file to be the submitted one (size and SHA-256). A refusal writes nothing.
   */
  async function decide(channelId: string, imageId: string, input: unknown, userId: string): Promise<{ image: OwnerImageView }> {
    const parsed = parseWithSchema(ownerImageDecisionInputSchema, input, "image decision");
    await requireImage(channelId, imageId);
    return ports.withLock(async () => {
      const { image, decisions } = await requireImage(channelId, imageId);
      const view = imageViewOf(image, decisions);
      if (view.status !== "pending") throw notPending(view);
      const file = await fileStateOf(image);
      const approving = parsed.action !== "return";
      if (approving && file === "missing") {
        throw new DomainError({ code: "image_review_file_missing", message: "The image's file is not on this computer: it cannot be approved unseen", details: { imageId } });
      }
      if (approving && file === "changed") {
        throw new DomainError({ code: "image_review_file_changed", message: "The image's file on this computer is not the one the Producer submitted", details: { imageId } });
      }
      const kind = parsed.action === "approve" ? "approved" : parsed.action === "approve_with_note" ? "approved_with_note" : "returned";
      const comment = kind === "approved" ? null : (parsed.comment ?? "").trim();
      const record: ImageReviewDecision = { id: `id_${ports.randomId()}`.slice(0, 40), imageId, kind, by: "owner", comment, device: await ports.deviceLabel(), at: stamp() };
      await ports.store.addDecision(channelId, record);
      await ports.audit({
        channelId,
        imageId,
        detail: { event: `image_review.${kind}`, at: record.at, decisionId: record.id, imageId, sceneId: image.sceneId, imagePath: image.imagePath, sha256: image.sha256, comment, by: userId, device: record.device },
      });
      // ADR 0066: the Producer's Inbox writer runs soon; it never throws and never holds the decision.
      ports.notifyOwnerDecision?.();
      return { image: { ...imageViewOf(image, [...decisions, record]), file } };
    });
  }

  /** The image's file on this computer (the shared workspace rule again), with its type; null when not here. */
  async function imageFile(channelId: string, imageId: string): Promise<(ResolvedImageFile & { type: string }) | null> {
    const { image } = await requireImage(channelId, imageId);
    const file = await localFile(image);
    const kind = file ? imageFileTypeOf(file.path) : null;
    return file && kind ? { ...file, type: kind.type } : null;
  }

  /** A large JPEG preview for the grid, or the original when none can be made; null when the file is not here. */
  async function previewFile(channelId: string, imageId: string): Promise<{ body: Uint8Array; type: string } | { file: ResolvedImageFile; type: string } | null> {
    const file = await imageFile(channelId, imageId);
    if (!file) return null;
    const body = await ports.preview(file.path);
    return body ? { body, type: "image/jpeg" } : { file, type: file.type };
  }

  return { submit, withdraw, get, list, ownerList, ownerWaiting, decide, imageFile, previewFile };
}

export type ImageReviewsService = ReturnType<typeof createImageReviewsService>;

/** What the Producer gets (MCP): submit, withdraw, list, get -- never a decision. */
export type ImageReviewsProducerSurface = Pick<ImageReviewsService, "submit" | "withdraw" | "list" | "get">;
export function producerSurface(service: ImageReviewsProducerSurface): ImageReviewsProducerSurface {
  return { submit: (input, producer) => service.submit(input, producer), withdraw: (input) => service.withdraw(input), list: (input) => service.list(input), get: (input) => service.get(input) };
}

/** What the owner's Web UI routes get: the list, the waiting count (the badge), the decision, the file and its preview. */
export type ImageReviewsOwnerSurface = Pick<ImageReviewsService, "ownerList" | "ownerWaiting" | "decide" | "imageFile" | "previewFile">;
export function ownerSurface(service: ImageReviewsOwnerSurface): ImageReviewsOwnerSurface {
  return {
    ownerList: (channelId) => service.ownerList(channelId),
    ownerWaiting: (channelId) => service.ownerWaiting(channelId),
    decide: (channelId, imageId, input, userId) => service.decide(channelId, imageId, input, userId),
    imageFile: (channelId, imageId) => service.imageFile(channelId, imageId),
    previewFile: (channelId, imageId) => service.previewFile(channelId, imageId),
  };
}
