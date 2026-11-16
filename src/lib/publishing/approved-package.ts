import { normalizeLineEndings } from "./package-text";
import { packageLocalizationSet, type ReleasePackage } from "./packages";
import { uploadTags, type PublishingSettings } from "./settings";
import type { ApprovedPackage } from "./upload-runner";

// BL-265 (ADR 0072 §4, §5): the one way a release package's manifest becomes the package an upload row freezes -- used by the
// approval (owner, automatic, Producer), by the runner's refresh of a queued row after a re-package, and by the packaging fix after
// upload ("the manifest now"). Pure.

/**
 * The frozen package of a row from a parsed manifest. `folder`: the package's folder relative to the workspace. `channelTags`: the
 * channel's common tags (a package with no tags of its own sends them, owner msg 2817). `videoSha256`: frozen whenever the manifest
 * states one (BL-265: owner rows too, AC-MG-21).
 */
export function approvedPackageOf(pkg: ReleasePackage, place: { manifestPath: string; folder: string }, settings: Pick<PublishingSettings, "channelTags">): ApprovedPackage {
  const localizations = packageLocalizationSet(pkg);
  return {
    video: pkg.video,
    // Lines end in LF on YouTube; the factory's Windows text may carry CRLF (review question).
    title: pkg.title,
    description: normalizeLineEndings(pkg.description),
    tags: uploadTags(pkg.tags, settings.channelTags ?? []),
    defaultLanguage: pkg.defaultLanguage,
    defaultAudioLanguage: pkg.defaultAudioLanguage,
    manifestPath: place.manifestPath,
    videoFile: `${place.folder}/${pkg.files.video}`,
    thumbnailFile: `${place.folder}/${pkg.files.thumbnail}`,
    sizeBytes: pkg.sizeBytes,
    // Review L5 / BL-265 (AC-MG-21): the runner checks the file against it before a session starts, on every row that froze it.
    ...(pkg.sha256 ? { videoSha256: pkg.sha256 } : {}),
    // BL-225 stage 3 (ADR 0051 §8): a v2 package's translations (as the shared rules send them), its own AI flag and its slot.
    ...(localizations ? { localizations } : {}),
    ...(typeof pkg.containsSyntheticMedia === "boolean" ? { containsSyntheticMedia: pkg.containsSyntheticMedia } : {}),
    ...(pkg.slotId ? { slotId: pkg.slotId } : {}),
  };
}

/** Which packaging fields of two frozen packages differ (the refresh's audit): texts, translations, thumbnail file, AI flag, languages. */
export function changedPackageFields(before: ApprovedPackage, after: ApprovedPackage): string[] {
  const keys: Array<keyof ApprovedPackage> = ["title", "description", "tags", "localizations", "thumbnailFile", "containsSyntheticMedia", "defaultLanguage", "defaultAudioLanguage", "manifestPath", "videoFile"];
  return keys.filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}
