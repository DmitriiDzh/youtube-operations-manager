import { parseWithSchema, type DomainErrorCode } from "@/lib/shared-domain";
import {
  DomainError,
  PACKAGE_REVIEW_LIMITS,
  type OwnerReviewState,
  type PackageMediaFile,
  type PackageReviewDecision,
  type PackageReviewDraft,
  type PackageReviewItem,
  type PackageReviewItemState,
  type PackageReviewRequired,
  type PackageReviewsSnapshot,
  type PackageReviewsView,
  type ReviewPackage,
  type ReviewPackagesResult,
} from "./contracts";
import { isMediaKeyed, latestOwnerDecision, ownerReviewStateOf, standingDecision, wellFormedDecision } from "./model";
import { manifestSha256Schema, packageDecisionInputSchema, packageReviewDraftInputSchema, packageReviewSwitchInputSchema } from "./schemas";
import { decisionsOfVideo, issueCounts, issuesOf } from "./issues";
import { roundSeconds, timedCommentsAsText, wellFormedDraft, wellFormedIssueActions, wellFormedTimedComments, withIssueIds, type DraftTimedComment, type IssueAction } from "./timed-comments";

// BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md stage 1): the owner's review of a channel's final release packages. Every port is
// injected: the store (the synced family), the channel's packages (the publishing scan, wired by the composition layer), files and
// hashing, the clock. Nothing here reaches YouTube.

export type PackageReviewsStore = {
  read(channelId: string): Promise<PackageReviewsSnapshot>;
  setRequired(channelId: string, required: PackageReviewRequired): Promise<void>;
  addDecision(channelId: string, decision: PackageReviewDecision): Promise<void>;
};

/** Owner TG 4817 (AC-TC-03): this computer's drafts of timed comments, one row per (channel, manifest). */
export type PackageReviewDraftsStore = {
  get(channelId: string, manifestSha256: string): Promise<{ commentsJson: string; updatedAt: Date } | null>;
  set(channelId: string, manifestSha256: string, commentsJson: string, updatedAt: Date): Promise<void>;
  remove(channelId: string, manifestSha256: string): Promise<void>;
  /** Review fix 5: removes the channel's drafts of packages it no longer has (re-packaged, removed); returns how many. */
  prune?(channelId: string, keepManifests: readonly string[], untouchedSince: Date): Promise<number>;
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
  /**
   * BL-265 (ADR 0072 §1): the channel's BL-263 recode aliases (V -> S) as the video list knows them (the composition layer reads
   * video-projects). Absent or failing: none -- a decision then counts for its own video code only (stricter).
   */
  recodeAliases?(channelId: string): Promise<ReadonlyMap<string, string>>;
  /** Owner TG 4817 (AC-TC-03): the drafts of timed comments (device-local). Absent: the draft calls refuse, a decision clears nothing. */
  drafts?: PackageReviewDraftsStore;
};

const VIDEO_TYPES: Readonly<Record<string, string>> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
const IMAGE_TYPES: Readonly<Record<string, string>> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const extensionOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "").toLowerCase();

/** Drafts of packages the channel no longer lists are removed once untouched this long. */
const DRAFT_PRUNE_DAYS = 14;

/** A stored draft row: stage 1 wrote the comments as an array; with issue actions (owner TG 4846) it is `{ comments, issueActions }`. */
function draftOfJson(value: unknown): { comments: DraftTimedComment[]; issueActions: IssueAction[] } {
  if (Array.isArray(value)) return { comments: wellFormedDraft(value), issueActions: [] };
  const v = (value ?? {}) as { comments?: unknown; issueActions?: unknown };
  return { comments: wellFormedDraft(v.comments), issueActions: wellFormedIssueActions(v.issueActions) };
}

const STATE_ORDER: Record<PackageReviewItemState, number> = { pending: 0, returned: 1, approved: 2, uploaded: 3 };

export function createPackageReviewsService(deps: PackageReviewsDeps) {
  const refuse = (code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) => new DomainError({ code, message, details });

  /** The gate's view; a document that cannot be read is "required, nothing approved" (AC-PR-07). Never throws. */
  async function ownerReviewState(channelId: string): Promise<OwnerReviewState> {
    const snapshot = await deps.store.read(channelId).catch(() => "unreadable" as const);
    return ownerReviewStateOf(snapshot, await aliasesFor(channelId, snapshot));
  }

  /** The recode aliases, read only where a decision could use them (a gated channel's document); never throws. */
  async function aliasesFor(channelId: string, snapshot: PackageReviewsSnapshot | "unreadable"): Promise<ReadonlyMap<string, string>> {
    if (snapshot === "unreadable" || !snapshot.exists || Object.keys(snapshot.decisions ?? {}).length === 0 || !deps.recodeAliases) return new Map();
    return deps.recodeAliases(channelId).catch(() => new Map());
  }

  async function snapshotOrUnreadable(channelId: string): Promise<PackageReviewsSnapshot | "unreadable"> {
    return deps.store.read(channelId).catch(() => "unreadable" as const);
  }

  async function thumbnailHashOf(channelId: string, pkg: ReviewPackage): Promise<string | null> {
    if (!pkg.thumbnailPath) return null;
    const file = await deps.resolveFile(channelId, pkg.thumbnailPath);
    return file ? deps.hashFile(file.path).catch(() => null) : null;
  }

  async function itemOf(pkg: ReviewPackage, gate: OwnerReviewState, comments: readonly PackageReviewDecision[]): Promise<PackageReviewItem> {
    // BL-265 (ADR 0072 §1): the decision on this package's MEDIA stands -- an approval survives a re-package of its packaging.
    const latest = standingDecision(gate, { manifestSha256: pkg.manifestSha256, video: pkg.video, videoSha256: pkg.videoSha256, videoSizeBytes: pkg.videoSizeBytes });
    let state: PackageReviewItemState;
    if (pkg.uploaded) state = "uploaded";
    else if (latest?.kind === "returned") state = "returned";
    else if (latest?.kind === "approved") state = "approved";
    else state = "pending";
    const own = comments.filter((c) => c.manifestSha256 === pkg.manifestSha256 || (c.video !== "" && (c.video === pkg.video || gate.aliases.get(c.video) === pkg.video)));
    // Owner TG 4846 (AC-IS-01): the video's issues across its package versions, with this package's answers.
    const issues = issuesOf(decisionsOfVideo(gate.decisions, pkg.video, gate.aliases), pkg.reviewReplies ?? [], pkg.manifestSha256);
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
      decision: latest?.kind === "approved" || latest?.kind === "returned" ? latest.kind : null,
      comment: latest?.comment ?? null,
      timedComments: latest?.timedComments ?? [],
      issues,
      issueCounts: issueCounts(issues),
      decidedAt: latest?.at ?? null,
      decidedOn: latest?.device ?? null,
      hasVideoSha256: pkg.videoSha256 !== null,
      otherProblems: pkg.otherProblems,
      packagingComments: own
        .slice()
        .reverse()
        .map((c) => ({ id: c.id, comment: c.comment ?? "", at: c.at, device: c.device })),
      videoId: pkg.videoId ?? null,
    };
  }

  /** The owner's screen: the switch, and every package of the channel not yet uploaded (pending first), plus the last decided uploads. */
  async function view(channelId: string): Promise<PackageReviewsView> {
    const snapshot = await snapshotOrUnreadable(channelId);
    const gate = ownerReviewStateOf(snapshot, await aliasesFor(channelId, snapshot));
    const decisions = snapshot === "unreadable" ? [] : Object.values(snapshot.decisions);
    const comments = decisions
      .map(wellFormedDecision)
      .filter((d): d is PackageReviewDecision => d !== null && d.kind === "packaging_comment")
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    const found = await deps.packages(channelId);
    const base = {
      channelId,
      required: gate.required,
      requiredUpdatedAt: snapshot === "unreadable" ? null : (snapshot.required?.updatedAt ?? null),
      readable: snapshot !== "unreadable",
    };
    if (found.status !== "ok") return { ...base, packages: found.status, items: [], waiting: 0 };
    // Review fix 5: a draft of a package the channel no longer has (re-packaged, removed) would never show again -- pruned here.
    // Only drafts untouched for DRAFT_PRUNE_DAYS: a package missing from one scan (its manifest being rewritten) keeps its draft.
    await deps.drafts?.prune?.(channelId, found.packages.map((p) => p.manifestSha256), new Date(deps.now().getTime() - DRAFT_PRUNE_DAYS * 86_400_000)).catch(() => 0);
    const decided = new Set(decisions.map((d) => (d as { manifestSha256?: unknown }).manifestSha256));
    // The scan lists packages by planned date (oldest first): the decided uploads kept are the latest ones.
    const uploadedKept = new Set(found.packages.filter((p) => p.uploaded && decided.has(p.manifestSha256)).slice(-PACKAGE_REVIEW_LIMITS.uploadedShown));
    const items: PackageReviewItem[] = [];
    for (const pkg of found.packages) {
      if (pkg.uploaded && !uploadedKept.has(pkg)) continue;
      items.push(await itemOf(pkg, gate, comments));
    }
    items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    // Review M2: with the gate off nothing waits for the owner (no badge); the items stay listed, neutral on the screen.
    return { ...base, packages: "ok", items, waiting: gate.required ? items.filter((i) => i.state === "pending").length : 0 };
  }

  /**
   * The bell and the Media menu badge (fix of BL-257: they never counted the packages waiting): the same count as `view().waiting`,
   * but a channel without the gate is 0 without scanning its packages -- the alerts poll asks every connected channel each minute.
   */
  async function waiting(channelId: string): Promise<number> {
    const gate = await ownerReviewState(channelId);
    if (!gate.required) return 0;
    return (await view(channelId)).waiting;
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
   * The owner's decision (Web UI only, AC-PR-08). BL-265 (ADR 0072 §1-§2): an approval is of the package's MEDIA -- refused when the
   * manifest states no video `sha256`, or this computer's mp4 is not `sizeBytes` long or does not hash to it (AC-MG-03/04); no
   * thumbnail is needed (AC-MG-05), its hash is only noted (an older build reads an approval with a null hash as none). A return needs
   * a comment and returns that mp4. Both are refused for an uploaded package. A packaging comment (a comment required) is allowed on
   * any package of the channel, uploaded ones and a channel without the gate included, and never changes the gate (AC-MG-07). The
   * latest approval or return stands until the upload, so the owner may change his mind.
   */
  async function decide(channelId: string, input: unknown): Promise<{ decision: PackageReviewDecision; view: PackageReviewsView }> {
    const parsed = parseWithSchema(packageDecisionInputSchema, input, "package review decision");
    await deps.assertDeviceAvailable();
    const pkg = await findPackage(channelId, parsed.manifestSha256, false);
    if (parsed.kind !== "packaging_comment" && pkg.uploaded) throw refuse("package_review_uploaded", `${pkg.video} is already on YouTube: its media is not reviewed any more (a packaging comment still is)`, { video: pkg.video });
    let media: { videoSha256: string; videoSizeBytes: number } | null = null;
    if (parsed.kind === "approved") {
      if (!pkg.videoSha256) throw refuse("package_review_no_sha256", `${pkg.video}'s manifest states no video sha256: it cannot be reviewed (the factory adds it)`, { video: pkg.video });
      const videoFile = await deps.resolveFile(channelId, pkg.videoPath);
      if (!videoFile) throw refuse("package_review_video_missing", `${pkg.video}'s video file is not on this computer`, { video: pkg.video });
      if (videoFile.bytes !== pkg.videoSizeBytes) {
        throw refuse("package_review_video_mismatch", `${pkg.video}'s video on this computer is not the one the manifest states (its size differs): wait for the copy to finish or ask the factory`, { video: pkg.video, expectedBytes: pkg.videoSizeBytes, actualBytes: videoFile.bytes });
      }
      const actual = await deps.hashFile(videoFile.path);
      if (actual !== pkg.videoSha256) {
        throw refuse("package_review_video_mismatch", `${pkg.video}'s video on this computer is not the one the manifest states (sha256 differs): wait for the copy to finish or ask the factory`, { video: pkg.video, expected: pkg.videoSha256, actual });
      }
      media = { videoSha256: pkg.videoSha256, videoSizeBytes: pkg.videoSizeBytes };
    } else if (pkg.videoSha256) {
      // A return (or a comment) names the mp4 the manifest states: a return holds that media, and a new mp4 is pending again.
      media = { videoSha256: pkg.videoSha256, videoSizeBytes: pkg.videoSizeBytes };
    }
    const thumbnailSha256 = await thumbnailHashOf(channelId, pkg);
    // Owner TG 4817 (AC-TC-05/06): the draft's timed comments go with an approval or a return as one batch, sorted by time; a return
    // without a general comment states them as its comment too (an older build drops a return without one).
    const decisionId = `pr_${deps.randomId()}`.slice(0, 40);
    // Owner TG 4846 (AC-IS-02): each new timed comment is an issue, `<decisionId>.<n>`.
    const timed = parsed.kind === "packaging_comment" ? [] : withIssueIds(decisionId, wellFormedTimedComments((parsed.timedComments ?? []).map((c) => ({ atSeconds: roundSeconds(c.atSeconds), text: c.text }))));
    // AC-IS-04: actions only on this channel's issues of this video (any of its package versions); another one refuses everything.
    const gateNow = await ownerReviewState(channelId);
    const known = issuesOf(decisionsOfVideo(gateNow.decisions, pkg.video, gateNow.aliases), pkg.reviewReplies ?? [], pkg.manifestSha256);
    const actions = parsed.kind === "packaging_comment" ? [] : wellFormedIssueActions(parsed.issueActions ?? []);
    const unknown = actions.filter((a) => !known.some((i) => i.id === a.issueId)).map((a) => a.issueId);
    if (unknown.length > 0) throw refuse("package_review_issue_unknown", `No issue of ${pkg.video} in this channel has these ids: ${unknown.join(", ")} (reload the video's comments)`, { video: pkg.video, issueIds: unknown });
    // AC-IS-03: the factory's answers the owner saw, so the thread survives the next re-package (only answers to known issues).
    const repliesSeen = parsed.kind === "packaging_comment" ? [] : (pkg.reviewReplies ?? []).filter((r) => known.some((i) => i.id === r.issueId));
    // A return without a general comment states its timed comments and follow-ups as `m:ss text` lines (an older build needs one).
    const followUps = actions.flatMap((a) => (a.kind === "follow_up" ? [{ atSeconds: known.find((i) => i.id === a.issueId)!.atSeconds, text: a.text ?? "" }] : []));
    const spoken = [...timed, ...followUps].sort((a, b) => a.atSeconds - b.atSeconds);
    const ownComment = (parsed.comment ?? "").trim();
    const commentGenerated = !ownComment && parsed.kind === "returned" && spoken.length > 0;
    const comment = ownComment || (commentGenerated ? timedCommentsAsText(spoken, PACKAGE_REVIEW_LIMITS.comment) : null);
    const decision: PackageReviewDecision = {
      id: decisionId,
      manifestSha256: pkg.manifestSha256,
      video: pkg.video,
      thumbnailSha256,
      kind: parsed.kind,
      comment,
      by: "owner",
      device: await deps.deviceLabel(),
      at: deps.now().toISOString(),
      ...(media ?? {}),
      ...(timed.length > 0 ? { timedComments: timed } : {}),
      ...(actions.length > 0 ? { issueActions: actions } : {}),
      ...(repliesSeen.length > 0 ? { repliesSeen } : {}),
      ...(commentGenerated ? { commentGenerated: true as const } : {}),
    };
    // Review fix 1 (AC-TC-05): the stored draft goes only when it is the one this decision was made from (`draftUpdatedAt` = its stamp;
    // null = the screen saw none). Another stored draft -- saved from the phone, or not loaded in this tab -- refuses the decision
    // before anything is written, so its comments are neither lost nor left out. Without `draftUpdatedAt` (an older screen) the draft
    // stays. A packaging comment never carries the draft and leaves it.
    const checkDraft = parsed.kind !== "packaging_comment" && parsed.draftUpdatedAt !== undefined && deps.drafts !== undefined;
    let draftToRemove = false;
    await deps.withLock(async () => {
      if (checkDraft) {
        const row = await deps.drafts!.get(channelId, pkg.manifestSha256);
        const stored = row ? row.updatedAt.toISOString() : null;
        if (stored !== (parsed.draftUpdatedAt ?? null)) {
          throw refuse("package_review_draft_changed", "Your comments at moments changed meanwhile (another tab or the phone): reload the video's comments and decide again", { manifestSha256: pkg.manifestSha256 });
        }
        draftToRemove = row !== null;
      }
      await deps.store.addDecision(channelId, decision);
      // Review 2 #5: the draft goes inside the same lock every draft save takes, so a save made meanwhile (the phone) is never lost.
      // Review fix 6: a draft that could not be removed would come back and go out twice -- audited, never silent.
      if (draftToRemove) {
        await deps.drafts!.remove(channelId, pkg.manifestSha256).catch((error: unknown) =>
          deps.audit({ channelId, video: pkg.video, detail: { event: "package_review.draft_remove_failed", decisionId: decision.id, manifestSha256: pkg.manifestSha256, message: error instanceof Error ? error.message : String(error) } }).catch(() => undefined)
        );
      }
    });
    await deps.audit({ channelId, video: pkg.video, detail: { event: `package_review.${decision.kind}`, decisionId: decision.id, manifestSha256: decision.manifestSha256, ...(media ?? {}), thumbnailSha256, comment, ...(timed.length > 0 ? { timedComments: timed.length } : {}) } });
    await deps.afterChange(channelId);
    return { decision, view: await view(channelId) };
  }

  function draftsStore(): PackageReviewDraftsStore {
    if (!deps.drafts) throw refuse("package_review_workspace_unavailable", "Drafts are not kept on this computer");
    return deps.drafts;
  }

  /**
   * Owner TG 4817 (AC-TC-03/04): the owner's draft of timed comments for one package of THIS channel (found by its manifest in the
   * channel's scan, else `package_review_not_found`) -- the comments with their ids, sorted by time; none: `[]`.
   */
  async function draft(channelId: string, manifestSha256: unknown): Promise<PackageReviewDraft> {
    const sha = parseWithSchema(manifestSha256Schema, manifestSha256, "package review draft manifest");
    const store = draftsStore();
    await findPackage(channelId, sha, true);
    const row = await store.get(channelId, sha);
    let stored: { comments: PackageReviewDraft["comments"]; issueActions: PackageReviewDraft["issueActions"] } = { comments: [], issueActions: [] };
    try {
      stored = row ? draftOfJson(JSON.parse(row.commentsJson)) : stored;
    } catch {
      // an unreadable row reads as an empty draft (its stamp still guards the next save)
    }
    // The stamp is the stored row's (null: no row): the screen sends it back with its next save and with its decision (review fixes 1-2).
    return { manifestSha256: sha, ...stored, updatedAt: row ? row.updatedAt.toISOString() : null };
  }

  /** AC-TC-03/04: replaces the draft whole (`comments: []` removes it). Only for a package of this channel. Local: no sync, no gate. */
  async function saveDraft(channelId: string, input: unknown): Promise<PackageReviewDraft> {
    const parsed = parseWithSchema(packageReviewDraftInputSchema, input, "package review draft");
    const store = draftsStore();
    await findPackage(channelId, parsed.manifestSha256, true);
    const comments = wellFormedDraft(parsed.comments);
    const issueActions = wellFormedIssueActions(parsed.issueActions ?? []);
    return deps.withLock(async () => {
      // Review fix 2: a save made on a stale base (`baseUpdatedAt` is not the stored draft's stamp) is refused, never written over it.
      if (parsed.baseUpdatedAt !== undefined) {
        const row = await store.get(channelId, parsed.manifestSha256);
        if ((row ? row.updatedAt.toISOString() : null) !== (parsed.baseUpdatedAt ?? null)) {
          throw refuse("package_review_draft_changed", "Your comments at moments changed meanwhile (another tab or the phone): reload them", { manifestSha256: parsed.manifestSha256 });
        }
      }
      if (comments.length === 0 && issueActions.length === 0) {
        await store.remove(channelId, parsed.manifestSha256);
        return { manifestSha256: parsed.manifestSha256, comments: [], issueActions: [], updatedAt: null };
      }
      const at = deps.now();
      // Stage 1 stored the comments as an array; with issue actions the row is an object (both are read).
      await store.set(channelId, parsed.manifestSha256, JSON.stringify(issueActions.length > 0 ? { comments, issueActions } : comments), at);
      return { manifestSha256: parsed.manifestSha256, comments, issueActions, updatedAt: at.toISOString() };
    });
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

  /**
   * Owner TG 4584 (BL-263 fix; ADR 0070 amendment, ADR 0071 §4): a local recode V -> S rewrites the manifest (new SHA-256) but not
   * the video or the thumbnail bytes, so the owner's LATEST decision on the old manifest (approved or returned) is copied to the new
   * one -- never a decision of the caller's own: only an existing owner decision is copied, with its `kind`, `comment`,
   * `thumbnailSha256`, `device` and original `at` (AC-PR-11 compares it with the upload rows' times), `video` set to the new code and
   * `carriedFrom` the old SHA-256. Nothing to copy: nothing written. When the new manifest's latest decision is already that copy (a
   * retried recode), nothing is written either and its kind is returned. A decision for a manifest no package has yet is inert, so
   * the caller copies BEFORE its own change. Throws when the document cannot be read or written (the caller then changes nothing).
   */
  async function carryDecision(channelId: string, input: { fromSha256: string; toSha256: string; video: string }): Promise<{ carried: "approved" | "returned" | null; wrote: boolean }> {
    const from = manifestSha256Schema.parse(input.fromSha256);
    const to = manifestSha256Schema.parse(input.toSha256);
    if (from === to) throw new Error("the manifest SHA-256 did not change: nothing to carry");
    if (typeof input.video !== "string" || input.video.trim() === "") throw new Error("video is required");
    return deps.withLock(async () => {
      const snapshot = await deps.store.read(channelId);
      if (!snapshot.exists) return { carried: null, wrote: false };
      const decisions = Object.values(snapshot.decisions ?? {});
      const latest = latestOwnerDecision(from, decisions);
      if (!latest) return { carried: null, wrote: false };
      // BL-265 (ADR 0072 §1): a decision on the mp4 itself needs no copy -- the recode changes names, never the mp4 bytes, and the
      // gate follows the V -> S recode alias. Only a BL-257 decision (keyed by the old manifest alone) is copied, as before.
      if (isMediaKeyed(latest)) return { carried: latest.kind as "approved" | "returned", wrote: false };
      const already = latestOwnerDecision(to, decisions);
      if (
        already &&
        already.carriedFrom === from &&
        already.kind === latest.kind &&
        already.comment === latest.comment &&
        already.thumbnailSha256 === latest.thumbnailSha256 &&
        already.at === latest.at
      ) {
        return { carried: latest.kind as "approved" | "returned", wrote: false };
      }
      const copy: PackageReviewDecision = {
        id: `pr_${deps.randomId()}`.slice(0, 40),
        manifestSha256: to,
        video: input.video,
        thumbnailSha256: latest.thumbnailSha256,
        kind: latest.kind,
        comment: latest.comment,
        by: "owner",
        device: latest.device,
        at: latest.at,
        carriedFrom: from,
        // Owner TG 4817: the owner's timed comments travel with his decision.
        // Review 2 #6: with the ORIGINAL decision's issue ids (a stage-1 comment has none stored), so the copy is the same issues.
        ...(latest.timedComments && latest.timedComments.length > 0 ? { timedComments: withIssueIds(latest.id, latest.timedComments) } : {}),
      };
      await deps.store.addDecision(channelId, copy);
      await deps
        .audit({ channelId, video: input.video, detail: { event: "package_review.carried", decisionId: copy.id, from: latest.id, kind: copy.kind, manifestSha256: to, carriedFrom: from, fromVideo: latest.video } })
        .catch(() => undefined);
      return { carried: copy.kind as "approved" | "returned", wrote: true };
    });
  }

  return { ownerReviewState, view, waiting, setRequired, decide, mediaFile, carryDecision, draft, saveDraft };
}

export type PackageReviewsService = ReturnType<typeof createPackageReviewsService>;

/** The owner's surface (the Web UI's package-review routes only, AC-PR-08). */
export function packageReviewsOwnerSurface(service: PackageReviewsService) {
  return { view: service.view, waiting: service.waiting, setRequired: service.setRequired, decide: service.decide, mediaFile: service.mediaFile, draft: service.draft, saveDraft: service.saveDraft };
}
export type PackageReviewsOwnerSurface = ReturnType<typeof packageReviewsOwnerSurface>;
