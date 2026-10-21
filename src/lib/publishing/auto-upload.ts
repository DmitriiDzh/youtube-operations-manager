// BL-209 (FO-REQ-0036; docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md; ADR 0046, amending ADR 0037 §1/§3): the automatic private
// upload of ready release packages. While the owner's switch is on, a background tick scans every connected channel's packages and
// queues each one that is ready and whose video file is exactly the one its manifest names (size, then SHA-256) -- private, never
// with a date. The rows go to the same upload runner as an approval (identity check, Live writes before every write, never twice).
// The checks at queue time are the approval's own (`upload-approval.ts` `queueAutomatic`). One try per manifest version: a manifest
// hash once auto-queued is never queued again by itself, whatever became of its upload. Switched off: nothing is read or hashed.

import { isDomainError } from "@/lib/shared-domain";
import type { PackageScanResult, ScannedPackage } from "./package-scan";
import { AUTO_UPLOAD_WAIT_CODES } from "./upload-approval";

/** `userId` null: the channel has no connected account on this computer (it is skipped, with the reason recorded). */
export type AutoUploadChannel = { channelId: string; userId: string | null };

/**
 * Why a ready, matching package (or a whole channel) is not queued now. Package reasons are the approval's refusal codes
 * (`upload_daily_limit`, `quota_insufficient`, `quota_unknown`, `publishing_settings_changed`, `upload_tags_too_long`, ...);
 * channel reasons are `no_connected_account`, `no_workspace` and `workspace_unavailable`.
 */
export type AutoUploadWaiting =
  | { kind: "package"; channelId: string; video: string; manifestSha256: string; reason: string }
  | { kind: "channel"; channelId: string; reason: string };

export type AutoUploadDeps = {
  /** The owner's switch (device-local, default off). Read at the start of a tick and again right before each queue. */
  enabled(): Promise<boolean>;
  /** The channels connected on this computer, each with the Google user the runner uploads as (`channels.connected_user_id`). */
  channels(): Promise<AutoUploadChannel[]>;
  scan(channelId: string): Promise<PackageScanResult>;
  /** The videos held by an upload row on this computer, and those another computer reports (the approval's own reads). */
  liveVideos(channelId: string): Promise<Set<string>>;
  peerUploads(channelId: string): Promise<Map<string, { host: string | null; uploaded: boolean }>>;
  /** The manifest hashes that already have an upload row here -- automatic or manual, any status (review M1). */
  triedHashes(channelId: string): Promise<Set<string>>;
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
  /**
   * A reason that appeared or changed (once per (manifest hash, reason) or (channel, reason) change, never every tick): the audit
   * event `publishing.upload_auto_waiting`.
   */
  logWaiting(entry: AutoUploadWaiting): Promise<void>;
  /** The reasons standing after a tick, for the Settings card; called only when they changed. */
  saveWaiting(entries: AutoUploadWaiting[]): Promise<void>;
  /** Kept between ticks (in memory): the reasons standing, by key, so only a change is logged. */
  waiting: Map<string, AutoUploadWaiting>;
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
  /** Every reason standing after this tick (packages and channels). */
  reasons: AutoUploadWaiting[];
};

const waitingKey = (entry: AutoUploadWaiting) => (entry.kind === "package" ? `package|${entry.channelId}|${entry.manifestSha256}` : `channel|${entry.channelId}`);

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

  /**
   * The tick's reasons replace the standing ones: a new or changed reason is logged once; a reason gone (queued, ready again, the
   * channel connected) is dropped, so it is logged again if it comes back. When the tick stopped early, the reasons of what it did
   * not reach this time stay as they were.
   */
  let savedSinceStart = false;

  async function settle(found: Map<string, AutoUploadWaiting>, visited: Set<string>, stoppedEarly: boolean): Promise<AutoUploadWaiting[]> {
    const next = new Map(found);
    if (stoppedEarly) for (const [key, entry] of deps.waiting) if (!visited.has(key) && !next.has(key)) next.set(key, entry);
    for (const [key, entry] of next) {
      const before = deps.waiting.get(key);
      if (before && before.reason === entry.reason) continue;
      warn(entry.kind === "package" ? `${entry.video}: waiting (${entry.reason})` : `channel ${entry.channelId} skipped (${entry.reason})`);
      await deps.logWaiting(entry).catch(() => undefined);
    }
    // Review L1: the first save after a start always runs, so a list stored before a restart never lingers on the card.
    const changed = !savedSinceStart || next.size !== deps.waiting.size || [...next].some(([key, entry]) => deps.waiting.get(key)?.reason !== entry.reason);
    deps.waiting.clear();
    for (const [key, entry] of next) deps.waiting.set(key, entry);
    const list = [...next.values()];
    if (changed) {
      await deps.saveWaiting(list).catch(() => undefined);
      savedSinceStart = true;
    }
    return list;
  }

  /** Off (at the start of a tick or midway): nothing waits any more; the stored list is cleared (once after a start, then on change). */
  async function clearWaiting(): Promise<void> {
    if (deps.waiting.size === 0 && savedSinceStart) return;
    deps.waiting.clear();
    await deps.saveWaiting([]).catch(() => undefined);
    savedSinceStart = true;
  }

  return {
    async tick(): Promise<AutoUploadTickResult> {
      const result: AutoUploadTickResult = { enabled: false, queued: [], waiting: null, reasons: [] };
      if (!(await deps.enabled())) {
        // Off: nothing waits any more (the card shows no reason); nothing else is read.
        await clearWaiting();
        return result;
      }
      result.enabled = true;
      const found = new Map<string, AutoUploadWaiting>();
      const visited = new Set<string>();
      const note = (entry: AutoUploadWaiting) => found.set(waitingKey(entry), entry);
      let stoppedEarly = false;
      channels: for (const channel of await deps.channels()) {
        visited.add(`channel|${channel.channelId}`);
        // Review L4: one channel's failure (an unreadable workspace, a database error) never stops the other channels; it is a
        // waiting reason of that channel, recorded once per change.
        try {
          if (channel.userId === null) {
            note({ kind: "channel", channelId: channel.channelId, reason: "no_connected_account" });
            continue;
          }
          const scanned = await deps.scan(channel.channelId);
          if (scanned.status !== "ok") {
            note({ kind: "channel", channelId: channel.channelId, reason: scanned.status });
            continue;
          }
          const live = await deps.liveVideos(channel.channelId);
          const peers = await deps.peerUploads(channel.channelId);
          const tried = await deps.triedHashes(channel.channelId);
          for (const p of scanned.packages) {
            if (!candidate(p)) continue;
            visited.add(`package|${channel.channelId}|${p.manifestSha256}`);
            const expected = p.pkg.sha256 ?? null;
            if (!expected) continue; // no `sha256` in the manifest: the owner's approval only
            if (live.has(p.pkg.video) || peers.has(p.pkg.video)) continue;
            if (tried.has(p.manifestSha256)) continue; // one try per manifest version; a cancelled or failed one stays the owner's
            const file = await deps.videoFile(channel.channelId, `${p.folder}/${p.pkg.files.video}`);
            if (!file || file.bytes !== p.pkg.sizeBytes) continue; // the size first: free; a different size is never hashed
            let actual: string;
            try {
              actual = await videoHash(p.manifestSha256, file);
            } catch (error) {
              note({ kind: "package", channelId: channel.channelId, video: p.pkg.video, manifestSha256: p.manifestSha256, reason: "hash_failed" });
              void error;
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
            if (!switchOn) {
              // Review L3: switched off midway -- the reasons are cleared like a tick that starts off.
              await clearWaiting();
              result.reasons = [];
              return result;
            }
            try {
              const queued = await deps.queue({ channelId: channel.channelId, userId: channel.userId, manifestPath: p.manifestPath, manifestSha256: p.manifestSha256, scanned, switchOn });
              tried.add(p.manifestSha256);
              result.queued.push({ channelId: channel.channelId, video: queued.video, uploadId: queued.id, manifestSha256: p.manifestSha256 });
            } catch (error) {
              const code = isDomainError(error) ? error.code : "refused";
              note({ kind: "package", channelId: channel.channelId, video: p.pkg.video, manifestSha256: p.manifestSha256, reason: code });
              if (code === "publishing_settings_changed") break; // this channel's settings wait for Merge; the next channel may go on
              if (AUTO_UPLOAD_WAIT_CODES.has(code)) {
                // The bucket and the pool are the project's: nothing else fits this tick either. Never dropped -- tried again later.
                result.waiting = code;
                stoppedEarly = true;
                break channels;
              }
              // Refused for this package alone (queued meanwhile, changed, not ready any more, tags too long): the next tick sees it again.
            }
          }
        } catch (error) {
          note({ kind: "channel", channelId: channel.channelId, reason: "channel_failed" });
          void error;
        }
      }
      result.reasons = await settle(found, visited, stoppedEarly);
      return result;
    },
  };
}

export type AutoPrivateUpload = ReturnType<typeof createAutoPrivateUpload>;
