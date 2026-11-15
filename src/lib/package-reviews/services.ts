import { parseWithSchema, type DomainErrorCode } from "@/lib/shared-domain";
import {
  DomainError,
  PACKAGE_REVIEW_LIMITS,
  type OwnerReviewState,
  type PackageMediaFile,
  type PackageReviewDecision,
  type PackageReviewItem,
  type PackageReviewItemState,
  type PackageReviewRequired,
  type PackageReviewsSnapshot,
  type PackageReviewsView,
  type ReviewPackage,
  type ReviewPackagesResult,
} from "./contracts";
import { latestOwnerDecision, ownerReviewStateOf } from "./model";
import { manifestSha256Schema, packageDecisionInputSchema, packageReviewSwitchInputSchema } from "./schemas";

// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 1): the owner's review of a channel's final release packages. Every port is
// injected: the store (the synced family), the channel's packages (the publishing scan, wired by the composition layer), files and
// hashing, the clock. Nothing here reaches YouTube.

export type PackageReviewsStore = {
  read(channelId: string): Promise<PackageReviewsSnapshot>;
  setRequired(channelId: string, required: PackageReviewRequired): Promise<void>;
  addDecision(channelId: string, decision: PackageReviewDecision): Promise<void>;
};

export type PackageReviewsDeps = {
  store: PackageReviewsStore;
  /** The channel's release packages on this computer (`cached`: a short-lived copy is fine -- the media routes). */
  packages(channelId: string, options?: { cached?: boolean }): Promise<ReviewPackagesResult>;
  /** A package's file under `04 Videos/` of the channel's workspace (the workspace rule and the real-path check), or null. */
  resolveFile(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null>;
  /** SHA-256 (lower-case hex) of a whole file. */
  hashFile(absolutePath: string): Promise<string>;
  assertDeviceAvailable(): Promise<void>;
  deviceLabel(): Promise<string | null>;
  now(): Date;
  randomId(): string;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  audit(event: { channelId: string; video: string; detail: Record<string, unknown> }): Promise<void>;
  /** After a decision or a switch: the plan's package cache is dropped (AC-PR-10) and the Producer's Inbox writer nudged (AC-PR-13). */
  afterChange(channelId: string): Promise<void> | void;
};

const VIDEO_TYPES: Readonly<Record<string, string>> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const IMAGE_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const extensionOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "").toLowerCase();

const STATE_ORDER: Record<PackageReviewItemState, number> = { pending: 0, returned: 1, approved: 2, uploaded: 3 };

export function createPackageReviewsService(deps: PackageReviewsDeps) {
  const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

  /** The gate's view; a document that cannot be read is "required, nothing approved" (AC-PR-07). Never throws. */
  async function ownerReviewState(channelId: string): Promise<OwnerReviewState> {
    const snapshot = await deps.store.read(channelId).catch(() => "unreadable" as const);
    return ownerReviewStateOf(snapshot);
  }

  async function snapshotOrUnreadable(channelId: string): Promise<PackageReviewsSnapshot | "unreadable"> {
    return deps.store.read(channelId).catch(() => "unreadable" as const);
  }

  async function thumbnailHashOf(channelId: string, pkg: ReviewPackage): Promise<string | null> {
    if (!pkg.thumbnailPath) return null;
    const file = await deps.resolveFile(channelId, pkg.thumbnailPath);
    return file ? deps.hashFile(file.path).catch(() => null) : null;
  }

  async function itemOf(channelId: string, pkg: ReviewPackage, decisions: readonly unknown[]): Promise<PackageReviewItem> {
    const latest = latestOwnerDecision(pkg.manifestSha256, decisions);
    let state: PackageReviewItemState;
    if (pkg.uploaded) state = "uploaded";
    else if (latest?.kind === "returned") state = "returned";
    else if (latest?.kind === "approved" && latest.thumbnailSha256 !== null && latest.thumbnailSha256 === (await thumbnailHashOf(channelId, pkg))) state = "approved";
    else state = "pending";
    return {
      manifestSha256: pkg.manifestSha256,
      manifestPath: pkg.manifestPath,
      video: pkg.video,
      title: pkg.title,
      description: pkg.description,
      languages: pkg.languages,
      slotId: pkg.slotId,
      plannedPublishDate: pkg.plannedPublishDate,
      durationSeconds: pkg.durationSeconds,
      thumbnailPath: pkg.thumbnailPath,
      state,
      comment: latest?.comment ?? null,
      decidedAt: latest?.at ?? null,
      decidedOn: latest?.device ?? null,
      hasVideoSha256: pkg.videoSha256 !== null,
      otherProblems: pkg.otherProblems,
    };
  }

  /** The owner's screen: the switch, and every package of the channel not yet uploaded (pending first), plus the last decided uploads. */
  async function view(channelId: string): Promise<PackageReviewsView> {
    const snapshot = await snapshotOrUnreadable(channelId);
    const gate = ownerReviewStateOf(snapshot);
    const decisions = snapshot === "unreadable" ? [] : Object.values(snapshot.decisions);
    const found = await deps.packages(channelId);
    const base = {
      channelId,
      required: gate.required,
      requiredUpdatedAt: snapshot === "unreadable" ? null : (snapshot.required?.updatedAt ?? null),
      readable: snapshot !== "unreadable",
    };
    if (found.status !== "ok") return { ...base, packages: found.status, items: [], waiting: 0 };
    const decided = new Set(decisions.map((d) => (d as { manifestSha256?: unknown }).manifestSha256));
    const items: PackageReviewItem[] = [];
    let uploadedShown = 0;
    for (const pkg of found.packages) {
      if (pkg.uploaded) {
        if (!decided.has(pkg.manifestSha256) || uploadedShown >= PACKAGE_REVIEW_LIMITS.uploadedShown) continue;
        uploadedShown += 1;
      }
      items.push(await itemOf(channelId, pkg, decisions));
    }
    items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    return { ...base, packages: "ok", items, waiting: items.filter((i) => i.state === "pending").length };
  }

  async function findPackage(channelId: string, manifestSha256: string, cached: boolean): Promise<ReviewPackage> {
    const found = await deps.packages(channelId, { cached });
    if (found.status !== "ok") throw refuse("package_review_workspace_unavailable", "The channel's packages cannot be read on this computer (Settings → Channels: its workspace folder)", { status: found.status });
    const pkg = found.packages.find((p) => p.manifestSha256 === manifestSha256);
    if (!pkg) throw refuse("package_review_not_found", "No package of this channel has this manifest on this computer (it may have been re-packaged: reload)", { manifestSha256 });
    return pkg;
  }

  /** The owner's switch (Web UI only). */
  async function setRequired(channelId: string, input: unknown): Promise<PackageReviewsView> {
    const { required } = parseWithSchema(packageReviewSwitchInputSchema, input, "package review switch");
    await deps.assertDeviceAvailable();
    await deps.withLock(async () => {
      await deps.store.setRequired(channelId, { value: required, updatedAt: deps.now().toISOString(), by: "owner", device: await deps.deviceLabel() });
    });
    await deps.audit({ channelId, video: "*", detail: { event: "package_review.switch", required } });
    await deps.afterChange(channelId);
    return view(channelId);
  }

  /**
   * The owner's decision (Web UI only, AC-PR-08). An approval names the manifest version and the thumbnail file's hash at this moment;
   * it is refused when the manifest states no video `sha256`, or this computer's mp4 does not hash to it (AC-PR-05). A return needs a
   * comment. The latest decision stands until the upload, so the owner may change his mind.
   */
  async function decide(channelId: string, input: unknown): Promise<{ decision: PackageReviewDecision; view: PackageReviewsView }> {
    const parsed = parseWithSchema(packageDecisionInputSchema, input, "package review decision");
    await deps.assertDeviceAvailable();
    const pkg = await findPackage(channelId, parsed.manifestSha256, false);
    if (pkg.uploaded) throw refuse("package_review_uploaded", `${pkg.video} is already on YouTube: nothing to review`, { video: pkg.video });
    let thumbnailSha256: string | null = null;
    if (parsed.kind === "approved") {
      if (!pkg.videoSha256) throw refuse("package_review_no_sha256", `${pkg.video}'s manifest states no video sha256: it cannot be reviewed (the factory adds it)`, { video: pkg.video });
      const videoFile = await deps.resolveFile(channelId, pkg.videoPath);
      if (!videoFile) throw refuse("package_review_video_missing", `${pkg.video}'s video file is not on this computer`, { video: pkg.video });
      const actual = await deps.hashFile(videoFile.path);
      if (actual !== pkg.videoSha256) {
        throw refuse("package_review_video_mismatch", `${pkg.video}'s video on this computer is not the one the manifest states (sha256 differs): wait for the copy to finish or ask the factory`, { video: pkg.video, expected: pkg.videoSha256, actual });
      }
      thumbnailSha256 = await thumbnailHashOf(channelId, pkg);
      if (!thumbnailSha256) throw refuse("package_review_thumbnail_missing", `${pkg.video}'s thumbnail file is not on this computer`, { video: pkg.video });
    } else {
      thumbnailSha256 = await thumbnailHashOf(channelId, pkg);
    }
    const comment = (parsed.comment ?? "").trim() || null;
    const decision: PackageReviewDecision = {
      id: `pr_${deps.randomId()}`.slice(0, 40),
      manifestSha256: pkg.manifestSha256,
      video: pkg.video,
      thumbnailSha256,
      kind: parsed.kind,
      comment,
      by: "owner",
      device: await deps.deviceLabel(),
      at: deps.now().toISOString(),
    };
    await deps.withLock(() => deps.store.addDecision(channelId, decision));
    await deps.audit({ channelId, video: pkg.video, detail: { event: `package_review.${decision.kind}`, decisionId: decision.id, manifestSha256: decision.manifestSha256, thumbnailSha256, comment } });
    await deps.afterChange(channelId);
    return { decision, view: await view(channelId) };
  }

  /**
   * The package's own video or thumbnail for the player (AC-PR-09): only a package of this channel, found by its manifest SHA-256 in
   * the channel's scan, and only its files under `04 Videos/`. Null when there is no such package or file here.
   */
  async function mediaFile(channelId: string, manifestSha256: unknown, which: "video" | "thumbnail"): Promise<PackageMediaFile | null> {
    const sha = manifestSha256Schema.safeParse(manifestSha256);
    if (!sha.success) return null;
    const found = await deps.packages(channelId, { cached: true });
    if (found.status !== "ok") return null;
    const pkg = found.packages.find((p) => p.manifestSha256 === sha.data);
    const relativePath = which === "video" ? pkg?.videoPath : pkg?.thumbnailPath;
    if (!pkg || !relativePath) return null;
    const type = (which === "video" ? VIDEO_TYPES : IMAGE_TYPES)[extensionOf(relativePath)];
    if (!type) return null;
    const file = await deps.resolveFile(channelId, relativePath);
    return file ? { path: file.path, bytes: file.bytes, type } : null;
  }

  return { ownerReviewState, view, setRequired, decide, mediaFile };
}

export type PackageReviewsService = ReturnType<typeof createPackageReviewsService>;

/** The owner's surface (the Web UI's package-review routes only, AC-PR-08). */
export function packageReviewsOwnerSurface(service: PackageReviewsService) {
  return { view: service.view, setRequired: service.setRequired, decide: service.decide, mediaFile: service.mediaFile };
}
export type PackageReviewsOwnerSurface = ReturnType<typeof packageReviewsOwnerSurface>;
