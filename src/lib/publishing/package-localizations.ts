import { isDomainError } from "@/lib/shared-domain";
import { sameLanguage } from "@/lib/shared-language-baseline";
import { localeKeyFor } from "@/lib/shared-localization-merge";
import type { ExpectedSnippet } from "@/lib/shared-video-localizations/contracts";
import type { VideoDetailsSnapshot } from "@/lib/video-details/contracts";
import { findUploadedPackage, readUploadedVideo, refuse, withPackageVideoLock, type PackageMetadataActor, type PackageMetadataDeps } from "./package-metadata";
import { youtubeDescriptionOf } from "./package-text";
import { packageLocalizationSet } from "./packages";

// Package localizations after upload (owner TG 4839/4842, 2026-11-24; ADR 0072 amendment; AGENTS.md §F «Package metadata after
// upload»): the owner (Web UI) and the Producer write an UPLOADED video's per-language titles/descriptions from its release package's
// CURRENT manifest `localizations` -- the same set the upload's translations step sends (`packageLocalizationSet`), never free text,
// never the video's own default language (that is the snippet, BL-265's path). No new writer and no new gateway function: the write
// is the shared video translations writer (`src/lib/shared-video-localizations/`: identity check, backup of the current translations,
// the safe merge that keeps every other language and deletes none, Live writes right before `videos.update`, read-back, audit), told
// what this check saw per language so a Studio edit in between fails closed. The writer sends the snippet back from its own read, so
// a lagging replica could echo an older title/description/tags over a package fix just written (review of 1c515813): the call names
// the texts the snippet must show (`expected`: YouTube's texts as checked, overridden by the latest package_metadata fix here when
// it is recent) and the writer waits for them or refuses; the read-back checks them too. Both package fixes of one video also run one
// at a time on this computer (`withPackageVideoLock`). One YouTube write per call: the texts fix is a separate call.

/** `videos.list` x2 (snapshot, translations) + the writer's fresh read, recheck, `videos.update` (50) and read-back + the status read after. */
export const PACKAGE_LOCALIZATIONS_QUOTA_UNITS = 56;

type Entry = { title: string; description: string };
type Field = "title" | "description";

/**
 * What this computer knows the video's translations got from the package side: `entries` per language; `complete` -- a language not
 * in `entries` was not sent (known absent), otherwise unknown. Unknown makes every difference on that language a conflict.
 */
export type LocalizationBaseline = {
  entries: Record<string, Entry>;
  complete: boolean;
  /** Languages explicitly unknown (an attempt here that did not read back verified): a difference there is a conflict. */
  unknown?: string[];
};

/** One audit row as this computer stores it (`video_edit_audit_events`), oldest first. */
export type AuditEventLike = { channelId: string; eventType: string; detail: unknown; occurredAt?: Date | null };

/** How recent a package_metadata fix must be for its texts to be the snippet the translations write must see (replica lag is seconds). */
export const RECENT_METADATA_FIX_MS = 15 * 60_000;

export type PackageLocalizationsDeps = Pick<PackageMetadataDeps, "findPackage" | "uploadRows" | "assertDeviceAvailable" | "credentialRef" | "snapshot"> & {
  /** The video's default language and translations as YouTube has them now (`videos.list snippet,localizations`); null: unreadable. */
  readLocalizations(args: { credentialRef: { userId: string }; channelId: string; videoId: string }): Promise<{ defaultLanguage: string | null; localizations: Record<string, Entry> } | null>;
  /** This computer's audit rows of the video, oldest first (the baseline and the recent texts fix are read from them). */
  auditEvents(channelId: string, videoId: string): Promise<AuditEventLike[]>;
  /** The shared video translations writer (source `package_localizations`). */
  writeLocalizations(args: {
    credentialRef: { userId: string };
    channelId: string;
    videoId: string;
    localizations: Record<string, Entry>;
    expectedCurrent: Record<string, Entry | null>;
    expected: ExpectedSnippet;
    auditContext: Record<string, unknown>;
  }): Promise<{ verified: true } | { verified: false; detail: string } | { sent: false; reason: string }>;
  audit(event: { channelId: string; videoId: string; eventType: "DRY_RUN" | "VERIFICATION"; detail: Record<string, unknown> }): Promise<void>;
};

export type PackageLocalizationStatus = "same" | "write" | "conflict";

export type PackageLocalizationRow = {
  language: string;
  status: PackageLocalizationStatus;
  /** Per field: YouTube now (null: no such language), what the upload sent (null: not sent; `undefined` never -- see `uploadedKnown`), the package. */
  fields: Array<{ field: Field; youtube: string | null; uploaded: string | null; package: string; status: PackageLocalizationStatus }>;
  /** Whether what the upload sent for this language is known here. */
  uploadedKnown: boolean;
};

export type PackageLocalizationsPreview = {
  dryRun: true;
  kind: "localizations";
  channelId: string;
  video: string;
  videoId: string;
  manifestSha256: string;
  etag: string | null;
  /** Where "what the upload sent" comes from: this computer's verified upload row, the latest fix here, or unknown (every difference a conflict). */
  baseline: "upload_row" | "localizations_apply" | "unknown";
  defaultLanguage: string | null;
  languages: PackageLocalizationRow[];
  /** Languages the video has that the package lacks: never removed, never changed. */
  kept: string[];
  /** A package language that is the video's own default language: never written as a translation (the snippet is BL-265's path). */
  ownLanguageSkipped: string[];
  changed: boolean;
  quotaUnits: number;
};

export type PackageLocalizationsApplyResult = {
  dryRun: false;
  kind: "localizations";
  channelId: string;
  video: string;
  videoId: string;
  manifestSha256: string;
  changed: boolean;
  written: string[];
  kept: string[];
  verified: boolean;
};

const ACTIVE_STATUS_FIELDS = ["privacyStatus", "publishAt"] as const;

function sameText(field: Field, a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return field === "description" ? youtubeDescriptionOf(a) === youtubeDescriptionOf(b) : a === b;
}

const entryOf = (map: Record<string, Entry>, language: string): Entry | null => {
  const key = localeKeyFor(map, language);
  return key === null ? null : map[key];
};

const sameInstant = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return Date.parse(a) === Date.parse(b);
};

/** The baseline the finished upload row here gives: its frozen translations when the translations step read back verified; none sent when the package had none. */
function rowBaseline(row: { packageJson: string; stepsJson?: string } | undefined): LocalizationBaseline | null {
  if (!row) return null;
  let step: unknown;
  let sent: unknown;
  try {
    step = (JSON.parse(row.stepsJson ?? "null") as { localizations?: unknown } | null)?.localizations;
    sent = (JSON.parse(row.packageJson) as { localizations?: unknown }).localizations;
  } catch {
    return null;
  }
  if (step === "none") return { entries: {}, complete: true };
  if (step !== "verified" || !sent || typeof sent !== "object") return null;
  const entries: Record<string, Entry> = {};
  for (const [language, value] of Object.entries(sent as Record<string, unknown>)) {
    const v = value as { title?: unknown; description?: unknown } | null;
    if (!v || typeof v.title !== "string" || typeof v.description !== "string") return null;
    entries[language] = { title: v.title, description: v.description };
  }
  return { entries, complete: true };
}

/** The baseline after a successful write: every package language as the package states it now, every other one as it was. */
export function afterLocalizationsOf(before: LocalizationBaseline, set: Record<string, Entry>): LocalizationBaseline {
  const entries: Record<string, Entry> = {};
  for (const [language, value] of Object.entries(before.entries)) if (entryOf(set, language) === null) entries[language] = value;
  for (const [language, value] of Object.entries(set)) entries[language] = value;
  const unknown = (before.unknown ?? []).filter((language) => entryOf(set, language) === null);
  return { entries, complete: before.complete, ...(unknown.length > 0 ? { unknown } : {}) };
}

const UNKNOWN: LocalizationBaseline = { entries: {}, complete: false };

const languagesOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

function parseBaseline(value: unknown): LocalizationBaseline | null {
  const after = value as { entries?: unknown; complete?: unknown; unknown?: unknown } | null;
  if (!after || typeof after !== "object" || typeof after.entries !== "object" || after.entries === null || typeof after.complete !== "boolean") return null;
  const entries: Record<string, Entry> = {};
  for (const [language, entry] of Object.entries(after.entries as Record<string, unknown>)) {
    const v = entry as { title?: unknown; description?: unknown } | null;
    if (!v || typeof v.title !== "string" || typeof v.description !== "string") return null;
    entries[language] = { title: v.title, description: v.description };
  }
  if (after.unknown !== undefined && !Array.isArray(after.unknown)) return null;
  const unknown = languagesOf(after.unknown);
  return { entries, complete: after.complete, ...(unknown.length > 0 ? { unknown } : {}) };
}

/** A baseline with these languages made unknown (their entries dropped). */
function withUnknown(baseline: LocalizationBaseline, languages: ReadonlySet<string>): LocalizationBaseline {
  if (languages.size === 0) return baseline;
  const isUnknown = (language: string) => [...languages].some((u) => sameLanguage(u, language));
  const entries: Record<string, Entry> = {};
  for (const [language, value] of Object.entries(baseline.entries)) if (!isUnknown(language)) entries[language] = value;
  const unknown = [...new Set([...(baseline.unknown ?? []), ...languages])];
  return { entries, complete: baseline.complete, unknown };
}

/**
 * What the upload (or the latest fix here) sent, from this computer's audit of the video (newest first) and its finished upload row:
 *  - the newest `package_localizations.applied` whose writer read back verified gives `afterLocalizations` (malformed: unknown);
 *  - a newer attempt that did not read back verified -- an applied row with the writer unverified, or the writer's own RESULT row
 *    (source package_localizations) with no applied row after it -- makes the languages it tried unknown;
 *  - otherwise the upload row's baseline, else unknown. Only rows of `channelId` count.
 */
export function localizationBaselineOf(
  events: readonly AuditEventLike[],
  channelId: string,
  fromRow: LocalizationBaseline | null
): { baseline: LocalizationBaseline; kind: "upload_row" | "localizations_apply" | "unknown" } {
  const tried = new Set<string>();
  let claimed = 0;
  for (const event of [...events].reverse()) {
    if (event.channelId !== channelId) continue;
    const detail = (event.detail ?? null) as Record<string, unknown> | null;
    if (!detail || typeof detail !== "object") continue;
    if (event.eventType === "VERIFICATION" && detail.event === "package_localizations.applied") {
      claimed += 1;
      // writerVerified: the translations read back as sent (a status-only change afterwards still leaves the baseline); older rows: verified.
      const writerVerified = typeof detail.writerVerified === "boolean" ? detail.writerVerified : detail.verified;
      if (typeof writerVerified !== "boolean") return { baseline: UNKNOWN, kind: "unknown" };
      if (writerVerified) {
        const parsed = parseBaseline(detail.afterLocalizations);
        if (!parsed) return { baseline: UNKNOWN, kind: "unknown" };
        return { baseline: withUnknown(parsed, tried), kind: "localizations_apply" };
      }
      for (const language of languagesOf(detail.languages)) tried.add(language);
      continue;
    }
    if (event.eventType === "RESULT" && detail.source === "package_localizations") {
      if (claimed > 0) {
        claimed -= 1;
        continue;
      }
      for (const language of languagesOf(detail.languages)) tried.add(language);
    }
  }
  if (fromRow) return { baseline: withUnknown(fromRow, tried), kind: "upload_row" };
  return { baseline: UNKNOWN, kind: "unknown" };
}

/**
 * The default-language texts the translations write must see on the video before it sends the snippet back: YouTube's texts as this
 * check read them, overridden by what the latest `package_metadata` fix here sent when it is recent (a lagging replica may still show the
 * older text, here and in the writer's read).
 */
export function expectedSnippetOf(events: readonly AuditEventLike[], channelId: string, now: Pick<VideoDetailsSnapshot, "title" | "description" | "tags">, nowMs: number): ExpectedSnippet {
  const expected: { title: string; description: string; tags: string[] } = { title: now.title, description: now.description, tags: [...(now.tags ?? [])] };
  for (const event of [...events].reverse()) {
    if (event.channelId !== channelId || event.eventType !== "VERIFICATION") continue;
    const detail = (event.detail ?? null) as { event?: unknown; sent?: { title?: unknown; description?: unknown; tags?: unknown } } | null;
    if (detail?.event !== "package_metadata.applied") continue;
    const at = event.occurredAt instanceof Date ? event.occurredAt.getTime() : NaN;
    if (!(nowMs - at <= RECENT_METADATA_FIX_MS)) break;
    const sent = detail.sent ?? {};
    if (typeof sent.title === "string") expected.title = sent.title;
    if (typeof sent.description === "string") expected.description = sent.description;
    if (Array.isArray(sent.tags) && sent.tags.every((t) => typeof t === "string")) expected.tags = sent.tags as string[];
    break;
  }
  return expected;
}

/** A scheduled video that published between the two reads: private with a due `publishAt` -> public. Expected, not a change by the write. */
function scheduledPublish(before: Pick<VideoDetailsSnapshot, "privacyStatus" | "publishAt">, after: Pick<VideoDetailsSnapshot, "privacyStatus" | "publishAt">, nowMs: number): boolean {
  if (before.privacyStatus !== "private" || !before.publishAt || after.privacyStatus !== "public") return false;
  const due = Date.parse(before.publishAt);
  return Number.isFinite(due) && due <= nowMs + 60_000 && (!after.publishAt || sameInstant(after.publishAt, before.publishAt));
}

export function createPackageLocalizations(deps: PackageLocalizationsDeps) {
  async function inspect(channelId: string, video: string, actor: PackageMetadataActor) {
    const found = await findUploadedPackage(deps, channelId, video);
    const hasRaw = !!found.pkg.localizations && Object.keys(found.pkg.localizations).length > 0;
    const checked = packageLocalizationSet(found.pkg);
    if (hasRaw && !checked) throw refuse("package_metadata_invalid", `${video}'s package translations break the translation rules.`, { channelId, video, problems: ["localizations_invalid"] });
    const { rows, credentialRef, now } = await readUploadedVideo(deps, channelId, video, found.videoId, actor);
    const current = await deps.readLocalizations({ credentialRef, channelId, videoId: found.videoId });
    if (current === null) throw refuse("update_failed", `${video}'s translations on YouTube could not be read.`, { channelId, video, videoId: found.videoId });
    const defaultLanguage = current.defaultLanguage && current.defaultLanguage.trim() !== "" ? current.defaultLanguage : null;
    // The set as the writer sends it: a description in YouTube's form (LF, no trailing line breaks), so the exact read-back holds.
    const set: Record<string, Entry> = {};
    const ownLanguageSkipped: string[] = [];
    for (const [language, value] of Object.entries(checked ?? {})) {
      if (sameLanguage(language, defaultLanguage)) ownLanguageSkipped.push(language);
      else set[language] = { title: value.title, description: youtubeDescriptionOf(value.description) };
    }
    if (Object.keys(set).length > 0 && defaultLanguage === null) {
      throw refuse("validation_failed", `${video}'s video has no default language on YouTube: translations are never written to it (and it is never given one here).`, { channelId, video, videoId: found.videoId });
    }
    // What the upload sent: the latest fix here, else this computer's finished upload row of this video (verified translations step).
    const events = await deps.auditEvents(channelId, found.videoId);
    const doneRow = rows
      .filter((row) => row.status === "done" && row.videoId === found.videoId)
      .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
    const resolved = localizationBaselineOf(events, channelId, rowBaseline(doneRow));
    const baseline: PackageLocalizationsPreview["baseline"] = resolved.kind;
    const known = resolved.baseline;
    const languages: PackageLocalizationRow[] = Object.entries(set).map(([language, pkgEntry]) => {
      const yt = entryOf(current.localizations, language);
      const sentEntry = entryOf(known.entries, language);
      const explicitlyUnknown = (known.unknown ?? []).some((u) => sameLanguage(u, language));
      const uploadedKnown = sentEntry !== null || (known.complete && !explicitlyUnknown);
      const fields = (["title", "description"] as const).map((field) => {
        const youtube = yt ? yt[field] : null;
        const uploaded = sentEntry ? sentEntry[field] : null;
        let status: PackageLocalizationStatus;
        if (sameText(field, youtube, pkgEntry[field])) status = "same";
        else if (uploadedKnown && sameText(field, youtube, uploaded)) status = "write";
        else status = "conflict";
        return { field, youtube, uploaded, package: pkgEntry[field], status };
      });
      const status: PackageLocalizationStatus = fields.some((f) => f.status === "conflict") ? "conflict" : fields.some((f) => f.status === "write") ? "write" : "same";
      return { language, status, fields, uploadedKnown };
    });
    const kept = Object.keys(current.localizations).filter((language) => !sameLanguage(language, defaultLanguage) && entryOf(set, language) === null).sort();
    return { found, credentialRef, now, current, defaultLanguage, set, languages, kept, ownLanguageSkipped, baseline, known, events };
  }

  return {
    /** The dry run: every read and check, the per-language three-way table -- no backup, no write; a local DRY_RUN audit row only. */
    async preview(channelId: string, input: { video: string }, actor: PackageMetadataActor): Promise<PackageLocalizationsPreview> {
      const seen = await inspect(channelId, input?.video, actor);
      const preview: PackageLocalizationsPreview = {
        dryRun: true,
        kind: "localizations",
        channelId,
        video: seen.found.pkg.video,
        videoId: seen.found.videoId,
        manifestSha256: seen.found.manifestSha256,
        etag: seen.now.etag,
        baseline: seen.baseline,
        defaultLanguage: seen.defaultLanguage,
        languages: seen.languages,
        kept: seen.kept,
        ownLanguageSkipped: seen.ownLanguageSkipped,
        changed: seen.languages.some((l) => l.status !== "same"),
        quotaUnits: PACKAGE_LOCALIZATIONS_QUOTA_UNITS,
      };
      await deps
        .audit({ channelId, videoId: preview.videoId, eventType: "DRY_RUN", detail: { source: "package_localizations", actor: actor.kind, video: preview.video, manifestSha256: preview.manifestSha256, languages: seen.languages.map((l) => ({ language: l.language, status: l.status })) } })
        .catch(() => undefined);
      return preview;
    },

    /** The write: refused on any conflict (owner and Producer alike); only the languages to write are sent, every other one kept. */
    async apply(channelId: string, input: { video: string; expectedEtag?: string; expectedManifestSha256?: string }, actor: PackageMetadataActor): Promise<PackageLocalizationsApplyResult> {
      if (actor.kind === "owner" && (typeof input?.expectedEtag !== "string" || input.expectedEtag === "")) throw refuse("validation_failed", "expectedEtag is required: apply what the preview showed");
      if (actor.kind === "owner" && (typeof input?.expectedManifestSha256 !== "string" || input.expectedManifestSha256 === "")) {
        throw refuse("validation_failed", "expectedManifestSha256 is required: apply the package the preview showed");
      }
      // One package fix of a video at a time on this computer (the texts fix takes the same lock).
      return withPackageVideoLock(channelId, input?.video, () => applyLocked(channelId, input, actor));
    },
  };

  async function applyLocked(channelId: string, input: { video: string; expectedEtag?: string; expectedManifestSha256?: string }, actor: PackageMetadataActor): Promise<PackageLocalizationsApplyResult> {
      const seen = await inspect(channelId, input?.video, actor);
      const video = seen.found.pkg.video;
      const videoId = seen.found.videoId;
      if (input.expectedManifestSha256 !== undefined && input.expectedManifestSha256 !== seen.found.manifestSha256) {
        throw refuse("package_metadata_manifest_changed", `${video}'s package was re-packaged since the preview: preview it again.`, { channelId, video, expected: input.expectedManifestSha256, actual: seen.found.manifestSha256 });
      }
      if (input.expectedEtag !== undefined && input.expectedEtag !== seen.now.etag) {
        throw refuse("video_details_conflict", `${video}'s video changed on YouTube since the preview: preview it again.`, { videoId, expectedEtag: input.expectedEtag, actualEtag: seen.now.etag });
      }
      const conflicts = seen.languages.filter((l) => l.status === "conflict").map((l) => ({ language: l.language, fields: l.fields.filter((f) => f.status === "conflict").map((f) => f.field) }));
      if (conflicts.length > 0) {
        throw refuse(
          "package_localizations_conflict",
          `${video}: the translations ${conflicts.map((c) => c.language).join(", ")} on YouTube differ from both what the upload sent and the package (changed in Studio, by Batches, or uploaded from the other computer): nothing was written.`,
          { channelId, video, conflicts, baseline: seen.baseline }
        );
      }
      const toWrite = seen.languages.filter((l) => l.status === "write").map((l) => l.language);
      const base = { dryRun: false as const, kind: "localizations" as const, channelId, video, videoId, manifestSha256: seen.found.manifestSha256, kept: seen.kept };
      if (toWrite.length === 0) return { ...base, changed: false, written: [], verified: true };
      const localizations: Record<string, Entry> = {};
      const expectedCurrent: Record<string, Entry | null> = {};
      for (const language of toWrite) {
        localizations[language] = seen.set[language];
        expectedCurrent[language] = entryOf(seen.current.localizations, language);
      }
      const context = { actor: actor.kind, video, manifestSha256: seen.found.manifestSha256, languages: toWrite };
      let result: Awaited<ReturnType<PackageLocalizationsDeps["writeLocalizations"]>>;
      try {
        result = await deps.writeLocalizations({
          credentialRef: seen.credentialRef,
          channelId,
          videoId,
          localizations,
          expectedCurrent,
          expected: expectedSnippetOf(seen.events, channelId, seen.now, Date.now()),
          auditContext: context,
        });
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw refuse("update_failed", error instanceof Error ? error.message : String(error));
      }
      // The untouched status fields read back as they were before the write (the writer reads only snippet and localizations).
      const after = await deps.snapshot({ credentialRef: seen.credentialRef, channelId, videoId });
      const changedStatus =
        after === "not_found"
          ? [...ACTIVE_STATUS_FIELDS]
          : scheduledPublish(seen.now, after, Date.now())
            ? []
            : ACTIVE_STATUS_FIELDS.filter((field) => (field === "publishAt" ? !sameInstant(after.publishAt, seen.now.publishAt) : after[field] !== seen.now[field]));
      const writerProblem = "sent" in result ? `not sent (${result.reason})` : result.verified ? null : result.detail;
      const verified = writerProblem === null && changedStatus.length === 0;
      await deps
        .audit({
          channelId,
          videoId,
          eventType: "VERIFICATION",
          detail: {
            source: "package_localizations",
            event: "package_localizations.applied",
            ...context,
            verified,
            // The translations themselves read back as sent: the baseline below holds even when a status field changed (review #3).
            writerVerified: writerProblem === null,
            ...(writerProblem ? { problem: writerProblem } : {}),
            ...(changedStatus.length > 0 ? { changedUntouched: changedStatus } : {}),
            // The next fix's baseline: written languages as sent; a language the package states and YouTube already had ("same") as it
            // is; every other language keeps the baseline it had (never YouTube's value of a language not written).
            afterLocalizations: afterLocalizationsOf(seen.known, seen.set),
          },
        })
        .catch(() => undefined);
      if (!verified) {
        throw refuse(
          "update_failed",
          writerProblem
            ? `The translations were sent, but the read-back differs: ${writerProblem}. Check them in Studio.`
            : `The translations were written, but ${changedStatus.join(", ")} read back changed: check the video in Studio.`,
          { channelId, video, videoId, languages: toWrite, ...(writerProblem ? { problem: writerProblem } : {}), ...(changedStatus.length > 0 ? { changedUntouched: changedStatus } : {}) }
        );
      }
      return { ...base, changed: true, written: toWrite, verified: true };
  }
}

export type PackageLocalizations = ReturnType<typeof createPackageLocalizations>;
