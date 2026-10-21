// BL-209 (FO-REQ-0036; docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md; ADR 0046, amending ADR 0037 §1/§3): the automatic private
// upload of ready release packages. While the owner's switch is on, a background tick scans every connected channel's packages and
// queues each one that is ready and whose video file is exactly the one its manifest names (size, then SHA-256) -- private, never
// with a date. The rows go to the same upload runner as an approval (identity check, Live writes before every write, never twice).
// The checks at queue time are the approval's own (`upload-approval.ts` `queueAutomatic`). One try per manifest version: a manifest
// hash once auto-queued is never queued again by itself, whatever became of its upload. Switched off: nothing is read or hashed.

import { isDomainError } from "@/lib/shared-domain";
import type { PackageScanResult, ScannedPackage } from "./package-scan";
import { AUTO_UPLOAD_WAIT_CODES } from "./upload-approval";

export type AutoUploadChannel = { channelId: string; userId: string };

export type AutoUploadDeps = {
  /** The owner's switch (device-local, default off). Read at the start of a tick and again right before each queue. */
  enabled(): Promise<boolean>;
  /** The channels connected on this computer, each with the Google user the runner uploads as (`channels.connected_user_id`). */
  channels(): Promise<AutoUploadChannel[]>;
  scan(channelId: string): Promise<PackageScanResult>;
  /** The videos held by an upload row on this computer, and those another computer reports (the approval's own reads). */
  liveVideos(channelId: string): Promise<Set<string>>;
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** The manifest hashes already auto-queued for the channel (any status). */
  autoQueuedHashes(channelId: string): Promise<Set<string>>;
  /** The package's video file by the workspace rule, with its size and modification time; null when it is not there. */
  videoFile(channelId: string, relativePath: string): Promise<{ path: string; bytes: number; mtimeMs: number } | null>;
  /** The SHA-256 (lower-case hex) of a whole file. Costly on a multi-GB video: called only after the size matched, once per key. */
  hashFile(absolutePath: string): Promise<string>;
  /** The approval's `queueAutomatic`. */
  queue(input: {
    channelId: string;
    userId: string;
    manifestPath: string;
    manifestSha256: string;
    scanned: Extract<PackageScanResult, { status: "ok" }>;
    switchOn: boolean;
  }): Promise<{ id: string; video: string }>;
  /** A video whose SHA-256 differs from its manifest's, logged once per manifest hash. */
  logMismatch(args: { channelId: string; video: string; manifestSha256: string; expected: string; actual: string }): Promise<void>;
  /** Kept between ticks (in memory): `${manifestSha256}|${bytes}|${mtimeMs}` -> the video's SHA-256; and the hashes logged. */
  hashCache: Map<string, string>;
  loggedMismatches: Set<string>;
  warn?(message: string): void;
};

export type AutoUploadTickResult = {
  /** Whether the switch was on at the start of the tick. */
  enabled: boolean;
  queued: Array<{ channelId: string; video: string; uploadId: string; manifestSha256: string }>;
  /** Set when the tick stopped early on a full bucket / quota (waits for a later tick). */
  waiting: string | null;
};

/** What a package must be before its video is even looked at: ready by the scan's checks, with a manifest hash and a video hash. */
function candidate(p: ScannedPackage): p is ScannedPackage & { pkg: NonNullable<ScannedPackage["pkg"]>; manifestSha256: string } {
  return p.state === "ready" && p.pkg !== null && p.thumbnailPath !== null && p.manifestSha256 !== null && p.youtube === null;
}

export function createAutoPrivateUpload(deps: AutoUploadDeps) {
  const warn = deps.warn ?? (() => undefined);

  /** The video's SHA-256 at most once per (manifest hash, size, mtime): a finished video does not change. */
  async function videoHash(manifestSha256: string, file: { path: string; bytes: number; mtimeMs: number }): Promise<string> {
    const key = `${manifestSha256}|${file.bytes}|${file.mtimeMs}`;
    const cached = deps.hashCache.get(key);
    if (cached !== undefined) return cached;
    const hash = (await deps.hashFile(file.path)).toLowerCase();
    deps.hashCache.set(key, hash);
    return hash;
  }

  return {
    async tick(): Promise<AutoUploadTickResult> {
      const result: AutoUploadTickResult = { enabled: false, queued: [], waiting: null };
      if (!(await deps.enabled())) return result;
      result.enabled = true;
      for (const channel of await deps.channels()) {
        const scanned = await deps.scan(channel.channelId);
        if (scanned.status !== "ok") continue;
        const live = await deps.liveVideos(channel.channelId);
        const peers = await deps.peerUploads(channel.channelId);
        const tried = await deps.autoQueuedHashes(channel.channelId);
        for (const p of scanned.packages) {
          if (!candidate(p)) continue;
          const expected = p.pkg.sha256 ?? null;
          if (!expected) continue; // no `sha256` in the manifest: the owner's approval only
          if (live.has(p.pkg.video) || peers.has(p.pkg.video)) continue;
          if (tried.has(p.manifestSha256)) continue; // one try per manifest version
          const file = await deps.videoFile(channel.channelId, `${p.folder}/${p.pkg.files.video}`);
          if (!file || file.bytes !== p.pkg.sizeBytes) continue; // the size first: free; a different size is never hashed
          let actual: string;
          try {
            actual = await videoHash(p.manifestSha256, file);
          } catch (error) {
            warn(`${p.pkg.video}: the video could not be hashed: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          if (actual !== expected) {
            if (!deps.loggedMismatches.has(p.manifestSha256)) {
              deps.loggedMismatches.add(p.manifestSha256);
              await deps.logMismatch({ channelId: channel.channelId, video: p.pkg.video, manifestSha256: p.manifestSha256, expected, actual }).catch(() => undefined);
            }
            continue;
          }
          // Hashing a large file takes a while: the owner may have switched it off meanwhile.
          const switchOn = await deps.enabled();
          if (!switchOn) return result;
          try {
            const queued = await deps.queue({ channelId: channel.channelId, userId: channel.userId, manifestPath: p.manifestPath, manifestSha256: p.manifestSha256, scanned, switchOn });
            tried.add(p.manifestSha256);
            result.queued.push({ channelId: channel.channelId, video: queued.video, uploadId: queued.id, manifestSha256: p.manifestSha256 });
          } catch (error) {
            const code = isDomainError(error) ? error.code : null;
            if (code === "publishing_settings_changed") break; // this channel's settings wait for Merge; the next channel may go on
            if (code !== null && AUTO_UPLOAD_WAIT_CODES.has(code)) {
              // The bucket and the pool are the project's: nothing else fits this tick either. Never dropped -- tried again later.
              result.waiting = code;
              return result;
            }
            // Refused for this package alone (queued meanwhile, changed, not ready any more, tags too long): the next tick sees it again.
            warn(`${p.pkg.video}: not queued automatically: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return result;
    },
  };
}

export type AutoPrivateUpload = ReturnType<typeof createAutoPrivateUpload>;
