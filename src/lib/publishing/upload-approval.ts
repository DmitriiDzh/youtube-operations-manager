// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 4; FO-REQ-0023 §4 B4; ADR 0037 §3): the owner's approval of a selection of
// release packages. It binds to what the owner saw -- each manifest's hash and the publishing settings shown -- and is refused
// whole when anything changed since, when a package is not ready or already queued, when a publish time is 15 minutes away or
// less, or when the day's quota cannot carry it. A row with a date approves both UPLOAD_PRIVATE and PUBLISH; a row without one
// only uploads (private, no date). Nothing is sent to YouTube here: the rows are queued for the upload runner.

import type { StoredPublishingUpload } from "@/lib/db";
import type { UnitsVerdict } from "@/lib/quota-guard";
import { DomainError } from "@/lib/shared-domain";
import type { PackageScanResult } from "./package-scan";
import type { PublishingSettingsView } from "./settings-service";
import { uploadTags, type PublishingSettings } from "./settings";
import { tagsLength } from "./packages";
import { estimateUploadUnits, isDeferredPublishAt } from "./publish-dates";
import { normalizeLineEndings, type ApprovedPackage } from "./upload-runner";

export { estimateUploadUnits };

/** YouTube's own daily bucket for `videos.insert` (since 2026-06-01): 100 per project. */
export const UPLOADS_PER_DAY = 100;
/** One approval at most: the owner uploads 5–10 at a time (FO-REQ-0023 §3). */
export const MAX_UPLOADS_PER_APPROVAL = 25;
const PUBLISH_AT_MARGIN_MS = 15 * 60_000;

export type ApprovalItem = { manifestPath: string; manifestSha256: string; publishAt: string | null };

export type UploadApprovalDeps = {
  scan(channelId: string): Promise<PackageScanResult>;
  settings(channelId: string): Promise<PublishingSettingsView>;
  /** The videos of the channel that already have a live upload row on this computer. */
  liveVideos(channelId: string): Promise<Set<string>>;
  /** The videos of the channel another computer reports as uploading or uploaded, with that computer's name (ADR 0037 §4). */
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** `videos.insert` calls since the quota day began (this computer's log and the shared one). */
  insertsToday(now: Date): Promise<number>;
  /** What this computer's queued and unfinished uploads will still spend: inserts not made yet, and their pool units (review). */
  pending(now: Date): Promise<{ inserts: number; units: number }>;
  checkUnits(units: number): Promise<UnitsVerdict>;
  insert(rows: StoredPublishingUpload[]): Promise<boolean>;
  newId(): string;
  audit(args: { channelId: string; detail: Record<string, unknown> }): Promise<void>;
  clock: { now(): Date };
};

const sameSettings = (a: PublishingSettings, b: PublishingSettings) =>
  // By value: `channelTags` is a list (owner msg 2753), so two equal lists are the same setting.
  (Object.keys(a) as Array<keyof PublishingSettings>).every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key])) && Object.keys(a).length === Object.keys(b).length;

type Refuse = (code: ConstructorParameters<typeof DomainError>[0]["code"], message: string, details?: Record<string, unknown>) => DomainError;

/** BL-209: who queued the rows -- the owner on the approval screen, or his automatic-upload switch (ADR 0046). */
type QueueMode = { automatic: false } | { automatic: true; switchOn: boolean };

/** The DomainError codes after which the automatic upload waits for a later tick instead of giving the package up (plan §2). */
export const AUTO_UPLOAD_WAIT_CODES: ReadonlySet<string> = new Set(["upload_daily_limit", "quota_insufficient", "quota_unknown", "publishing_settings_changed"]);

export function createUploadApproval(deps: UploadApprovalDeps) {
  /**
   * The checks every queued row passes, whoever queued it (ADR 0037 §3–§5, ADR 0046): ready, not held here or by a peer, a publish
   * time far enough ahead, the day's `videos.insert` bucket and the quota pool, the tags. Then the rows are inserted (all or none)
   * and each one is audited. Shared by the owner's approval and the automatic upload, so the two can never check differently.
   */
  async function queue(args: {
    channelId: string;
    userId: string;
    items: ApprovalItem[];
    view: PublishingSettingsView;
    scanned: Extract<PackageScanResult, { status: "ok" }>;
    acknowledgeUnknownQuota: boolean;
    mode: QueueMode;
    refuse: Refuse;
    now: Date;
  }): Promise<{ uploads: Array<{ id: string; video: string; publishAt: string | null }>; estimatedUnits: number }> {
    const { refuse, now, view, scanned } = args;
    const live = await deps.liveVideos(args.channelId);
    const elsewhere = await deps.peerUploads(args.channelId);

    const chosen = args.items.map((item) => {
      const found = scanned.packages.find((p) => p.manifestPath === item.manifestPath);
      if (!found || !found.pkg) throw refuse("upload_package_not_ready", `${item.manifestPath} is not a package that can be uploaded.`, { manifestPath: item.manifestPath });
      if (found.manifestSha256 !== item.manifestSha256) throw refuse("upload_package_changed", `${found.pkg.video}: the package changed after it was shown.`, { video: found.pkg.video });
      if (found.youtube !== null || live.has(found.pkg.video)) throw refuse("upload_already_queued", `${found.pkg.video} is already queued or uploaded.`, { video: found.pkg.video });
      const peer = elsewhere.get(found.pkg.video);
      if (peer) {
        const host = peer.host ?? "another computer";
        throw refuse("upload_already_queued", peer.uploaded ? `${found.pkg.video} was already uploaded from ${host}.` : `${found.pkg.video} is being uploaded on ${host}.`, { video: found.pkg.video, host });
      }
      if (found.state !== "ready" || !found.thumbnailPath) throw refuse("upload_package_not_ready", `${found.pkg.video} is not ready to upload.`, { video: found.pkg.video, problems: found.problems });
      if (item.publishAt !== null) {
        const at = Date.parse(item.publishAt);
        if (Number.isNaN(at)) throw refuse("validation_failed", `${found.pkg.video}: the publish time is not a date.`);
        if (at <= now.getTime() + PUBLISH_AT_MARGIN_MS) {
          throw refuse("publish_at_too_soon", `${found.pkg.video}: a publish time must be more than 15 minutes from now.`, { video: found.pkg.video, publishAt: item.publishAt });
        }
      }
      return { item, found, pkg: found.pkg };
    });
    if (new Set(chosen.map((c) => c.pkg.video)).size !== chosen.length) throw refuse("validation_failed", "Two of the packages are the same video.");

    // The uploads already queued here spend the same bucket and pool: a second approval the same day counts them (review).
    const pending = await deps.pending(now);
    const insertsLeft = UPLOADS_PER_DAY - (await deps.insertsToday(now)) - pending.inserts;
    if (chosen.length > insertsLeft) throw refuse("upload_daily_limit", `${chosen.length} uploads chosen, ${Math.max(0, insertsLeft)} left today.`, { left: Math.max(0, insertsLeft), chosen: chosen.length });
    const estimatedUnits = chosen.reduce(
      (sum, c) =>
        sum +
        estimateUploadUnits({
          playlist: view.settings.playlistId !== null,
          deferredPublishAt: isDeferredPublishAt(c.item.publishAt, now),
        }),
      0
    );
    const verdict = await deps.checkUnits(estimatedUnits + pending.units);
    if (verdict.decision === "insufficient") {
      throw refuse("quota_insufficient", "Not enough of today's quota is left for these uploads.", { estimatedUnits: estimatedUnits + pending.units, remainingUnits: verdict.remainingUnits, rowsToWrite: chosen.length, fitVideos: 0, resetsAt: verdict.resetsAt, canSplit: false });
    }
    if (verdict.decision === "unknown" && !args.acknowledgeUnknownQuota) {
      throw refuse("quota_unknown", "Today's quota cannot be read (Google Cloud is not connected or did not answer).", { estimatedUnits: estimatedUnits + pending.units, rowsToWrite: chosen.length, cloudConnected: verdict.cloudConnected });
    }

    // Owner msg 2817: the package's own tags, or the channel's when it has none; YouTube counts the list against 500 characters.
    const tooLong = chosen.find((c) => tagsLength(uploadTags(c.pkg.tags, view.settings.channelTags ?? [])) > 500);
    if (tooLong) {
      throw refuse("upload_tags_too_long", `${tooLong.pkg.video}: its tags are over YouTube's 500 characters.`, { video: tooLong.pkg.video });
    }

    const rows: StoredPublishingUpload[] = chosen.map(({ item, found, pkg }) => {
      const folder = found.folder;
      const approved: ApprovedPackage = {
        video: pkg.video,
        // Lines end in LF on YouTube; the factory's Windows text may carry CRLF (review question).
        title: pkg.title,
        description: normalizeLineEndings(pkg.description),
        tags: uploadTags(pkg.tags, view.settings.channelTags ?? []),
        defaultLanguage: pkg.defaultLanguage,
        defaultAudioLanguage: pkg.defaultAudioLanguage,
        manifestPath: found.manifestPath,
        videoFile: `${folder}/${pkg.files.video}`,
        thumbnailFile: `${folder}/${pkg.files.thumbnail}`,
        sizeBytes: pkg.sizeBytes,
        // Review L5: the runner checks an automatic row's file against it before a session starts.
        ...(args.mode.automatic && pkg.sha256 ? { videoSha256: pkg.sha256 } : {}),
      };
      return {
        id: deps.newId(),
        channelId: args.channelId,
        video: pkg.video,
        manifestPath: found.manifestPath,
        manifestSha256: item.manifestSha256,
        packageJson: JSON.stringify(approved),
        settingsJson: JSON.stringify(view.settings),
        publishAt: item.publishAt === null ? null : new Date(item.publishAt).toISOString(),
        approvedBy: args.userId,
        approvedAt: now,
        status: "queued",
        resumeStatus: null,
        pausedReason: null,
        pausedUntil: null,
        sessionUri: null,
        totalBytes: pkg.sizeBytes,
        storedBytes: 0,
        videoId: null,
        publishAtAtInsert: false,
        stepsJson: "{}",
        errorCode: null,
        errorMessage: null,
        attempts: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        leaseOwner: null,
        leaseUntil: null,
        automatic: args.mode.automatic,
      };
    });
    if (!(await deps.insert(rows))) throw refuse("upload_already_queued", "One of the videos was queued meanwhile.");
    for (const row of rows) {
      const detail =
        args.mode.automatic
          ? // ADR 0046 / plan §2 item 6: when, channel, package, manifest hash, the switch state and the resulting upload id.
            { event: "publishing.upload_auto_queued", at: now.toISOString(), channelId: row.channelId, uploadId: row.id, video: row.video, manifestSha256: row.manifestSha256, switchOn: args.mode.switchOn, publishAt: null, uploadPrivate: true, publish: false, automatic: true }
          : { event: "publishing.upload_approved", uploadId: row.id, video: row.video, publishAt: row.publishAt, uploadPrivate: true, publish: row.publishAt !== null, approvedBy: args.userId };
      await deps.audit({ channelId: args.channelId, detail });
    }
    return { uploads: rows.map((row) => ({ id: row.id, video: row.video, publishAt: row.publishAt })), estimatedUnits };
  }

  return {
    async approve(input: {
      channelId: string;
      userId: string;
      items: ApprovalItem[];
      shownSettings: PublishingSettings;
      acknowledgeUnknownQuota?: boolean;
    }): Promise<{ uploads: Array<{ id: string; video: string; publishAt: string | null }>; estimatedUnits: number }> {
      const now = deps.clock.now();
      const refuse: Refuse = (code, message, details) => new DomainError({ code, message, details: { channelId: input.channelId, ...details } });

      if (input.items.length === 0) throw refuse("validation_failed", "Choose at least one package to upload.");
      if (input.items.length > MAX_UPLOADS_PER_APPROVAL) throw refuse("validation_failed", `At most ${MAX_UPLOADS_PER_APPROVAL} packages in one approval.`);
      if (new Set(input.items.map((item) => item.manifestPath)).size !== input.items.length) throw refuse("validation_failed", "A package is listed twice.");

      const view = await deps.settings(input.channelId);
      if (view.conflictedFields.length > 0) {
        throw refuse("publishing_settings_changed", "Some publishing settings differ between the computers: choose them in Merge first.", { conflictedFields: view.conflictedFields });
      }
      if (!sameSettings(view.settings, input.shownSettings)) throw refuse("publishing_settings_changed", "The publishing settings changed after they were shown.");

      const scanned = await deps.scan(input.channelId);
      if (scanned.status !== "ok") throw refuse("validation_failed", scanned.status === "no_workspace" ? "This channel has no workspace folder on this computer." : `The workspace cannot be used: ${scanned.reason}`);
      return queue({ channelId: input.channelId, userId: input.userId, items: input.items, view, scanned, acknowledgeUnknownQuota: input.acknowledgeUnknownQuota === true, mode: { automatic: false }, refuse, now });
    },

    /**
     * BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md §2, ADR 0046): one package queued by the owner's automatic-upload switch -- the standing
     * approval he gave by turning it on. The same checks as `approve` against a scan made moments ago (the caller's, whose video
     * hash it verified), with no screen to bind to and no date: always private, `publishAt` null. An unknown quota is never
     * acknowledged (nobody is there to): it waits like a full bucket. The rows are marked `automatic`.
     */
    async queueAutomatic(input: {
      channelId: string;
      /** The channel's connected Google user: the runner uploads with that account, after the identity check. */
      userId: string;
      manifestPath: string;
      manifestSha256: string;
      scanned: Extract<PackageScanResult, { status: "ok" }>;
      switchOn: boolean;
    }): Promise<{ id: string; video: string }> {
      const now = deps.clock.now();
      const refuse: Refuse = (code, message, details) => new DomainError({ code, message, details: { channelId: input.channelId, ...details } });
      if (!input.switchOn) throw refuse("validation_failed", "The automatic upload is switched off.");
      const view = await deps.settings(input.channelId);
      if (view.conflictedFields.length > 0) {
        throw refuse("publishing_settings_changed", "Some publishing settings differ between the computers: choose them in Merge first.", { conflictedFields: view.conflictedFields });
      }
      const result = await queue({
        channelId: input.channelId,
        userId: input.userId,
        items: [{ manifestPath: input.manifestPath, manifestSha256: input.manifestSha256, publishAt: null }],
        view,
        scanned: input.scanned,
        acknowledgeUnknownQuota: false,
        mode: { automatic: true, switchOn: input.switchOn },
        refuse,
        now,
      });
      return { id: result.uploads[0].id, video: result.uploads[0].video };
    },
  };
}

export type UploadApproval = ReturnType<typeof createUploadApproval>;
