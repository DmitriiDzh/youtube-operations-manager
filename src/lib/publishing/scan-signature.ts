import { createHash } from "node:crypto";
import { youtubeRecordFileName } from "./packages";
import type { ScannedPackage } from "./package-scan";

/**
 * BL-270 (owner TG 4662/4665) and its review (findings 2, 3): the cheap fingerprints the plan progress's package-scan cache keys on.
 * Pure over its ports; `publishing/index.ts` wires the real ones.
 *
 * - `signature` is read BEFORE a scan: every file under the channel's `04 Videos/` (path, size, modification time, to the walk's
 *   depth), the removed-on-YouTube list, when the copy was last synced or checked, and the fields of the channel's videos rows the
 *   scan reads -- so a local-copy write by any module (finding 2: `video-details`' veto, plan date, Producer move, package metadata)
 *   moves it, not only a channel sync.
 * - `filesSignature` covers the files a kept scan actually resolved (finding 3): the manifest, the video, the thumbnails and the
 *   upload record a manifest names, followed through symlinks (size, modification time, real path) -- deeper than the walk's depth,
 *   or outside `04 Videos/` through a link. It is computed AFTER the scan from its result; `newestMtimeMs` lets the cache refuse a
 *   result whose files changed while it was being made.
 */
export type ScanSignatureDeps = {
  workspace(channelId: string): Promise<string | null>;
  folderSignature(workspace: string): Promise<string>;
  removedVideos(channelId: string): Promise<unknown>;
  channelTimes(channelId: string): Promise<{ lastSyncedAt: number | null; removedCheckAt: number | null } | null>;
  videos(channelId: string): Promise<unknown[]>;
  /** The file's (link-followed) size, modification time and real path; null when it cannot be read. */
  stat(absolutePath: string): Promise<{ size: number; mtimeMs: number; realPath: string } | null>;
  join(...parts: string[]): string;
};

/** The workspace-relative files a scanned package was built from (`/` between folders). */
export function referencedFilesOf(pkg: ScannedPackage): string[] {
  const files = [pkg.manifestPath];
  if (pkg.pkg) {
    files.push(`${pkg.folder}/${pkg.pkg.files.video}`, `${pkg.folder}/${pkg.pkg.files.thumbnail}`, `${pkg.folder}/${youtubeRecordFileName(pkg.pkg.video)}`);
    for (const thumbnail of pkg.pkg.thumbnails ?? []) files.push(`${pkg.folder}/${thumbnail.file}`);
    // BL-269: the caption files a v2 package names.
    for (const caption of pkg.pkg.captions ?? []) files.push(`${pkg.folder}/${caption.file}`);
  }
  return files;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function createPackageScanSignature(deps: ScanSignatureDeps) {
  return {
    async signature(channelId: string): Promise<string | null> {
      try {
        const workspace = await deps.workspace(channelId);
        if (!workspace) return null;
        const [folder, removed, channel, videos] = await Promise.all([
          deps.folderSignature(workspace),
          deps.removedVideos(channelId),
          deps.channelTimes(channelId),
          deps.videos(channelId),
        ]);
        return JSON.stringify([workspace, sha256(folder), removed, channel?.lastSyncedAt ?? null, channel?.removedCheckAt ?? null, sha256(JSON.stringify(videos))]);
      } catch {
        return null;
      }
    },

    async filesSignature(channelId: string, packages: readonly ScannedPackage[]): Promise<{ key: string; newestMtimeMs: number } | null> {
      try {
        const workspace = await deps.workspace(channelId);
        if (!workspace) return null;
        const relative = [...new Set(packages.flatMap(referencedFilesOf))].sort();
        let newestMtimeMs = Number.NEGATIVE_INFINITY;
        const lines: string[] = [];
        for (const file of relative) {
          const info = await deps.stat(deps.join(workspace, ...file.split("/")));
          if (info) newestMtimeMs = Math.max(newestMtimeMs, info.mtimeMs);
          lines.push(info ? `${file} ${info.size} ${info.mtimeMs} ${info.realPath}` : `${file} ?`);
        }
        return { key: sha256(lines.join("\n")), newestMtimeMs };
      } catch {
        return null;
      }
    },
  };
}
