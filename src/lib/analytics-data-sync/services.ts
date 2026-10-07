import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";
import type { AnalyticsShareImportResult, AnalyticsShareTables } from "@/lib/db";
import { ANALYTICS_DATA_DIR_NAME, ANALYTICS_DATA_FORMAT_VERSION, ANALYTICS_DATA_WINDOW_DAYS, MAX_PEER_FILE_BYTES, analyticsDataFileSchema } from "./contracts";

export type AnalyticsDataSyncDeps = {
  /** This device's id and the Syncthing folder; `folder: null` = not configured (everything is a no-op). */
  getConfig(): Promise<{ deviceId: string; folder: string | null }>;
  exportRows(fromSec: number, toSec: number): Promise<AnalyticsShareTables>;
  importRows(tables: AnalyticsShareTables): Promise<AnalyticsShareImportResult>;
  /** Persisted memory of imported peer files (`file → form`), so a restart does not re-import 45 days of files. */
  loadSeen(): Promise<Record<string, string>>;
  saveSeen(seen: Record<string, string>): Promise<void>;
  /** This device's synced video count: a file partly unapplied (unknown videos) is retried once it grows. */
  localVideoCount(): Promise<number>;
  clock: { now(): Date };
  log?: (message: string) => void;
};

const SAFE_DEVICE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isEmpty = (t: AnalyticsShareTables) => Object.values(t).every((rows) => (rows as unknown[]).length === 0);

export type ImportOutcome = { imported: string[]; skipped: Array<{ file: string; reason: string }>; incompleteChannels: string[] };

export function createAnalyticsDataSync(deps: AnalyticsDataSyncDeps) {
  const lastWritten = new Map<string, string>(); // own day file → digest of its content
  // peer file → "size:mtime" imported, or "size:mtime|partial|<video count>" when some rows could not be stored yet
  let seen: Map<string, string> | null = null;
  let importing: Promise<ImportOutcome> | null = null;
  let publishing: Promise<"published" | "unchanged" | "no_folder"> | null = null;

  async function folderOrNull(): Promise<{ deviceId: string; root: string } | null> {
    const { deviceId, folder } = await deps.getConfig();
    if (!folder || !SAFE_DEVICE_ID.test(deviceId)) return null;
    try {
      // Never creates the Syncthing folder itself: an unplugged drive must not get a local folder no peer sees.
      if (!(await stat(folder)).isDirectory()) return null;
    } catch {
      return null;
    }
    return { deviceId, root: path.join(folder, ANALYTICS_DATA_DIR_NAME) };
  }

  /** Imports every peer file not yet imported in its current form (one at a time per process). */
  async function importOnce(): Promise<ImportOutcome> {
    const outcome: ImportOutcome = { imported: [], skipped: [], incompleteChannels: [] };
    const where = await folderOrNull();
    if (!where) return outcome;
    seen ??= new Map(Object.entries(await deps.loadSeen().catch(() => ({}))));
    const known = seen;
    const videoCount = await deps.localVideoCount();
    const incomplete = new Set<string>();
    let changed = false;
    let devices: string[];
    try {
      devices = await readdir(where.root);
    } catch {
      return outcome;
    }
    const oldest = utcDay(deps.clock.now().getTime() - ANALYTICS_DATA_WINDOW_DAYS * DAY_MS);
    for (const peer of devices) {
      if (peer === where.deviceId || !SAFE_DEVICE_ID.test(peer)) continue;
      let names: string[];
      try {
        names = (await readdir(path.join(where.root, peer))).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const match = DAY_FILE.exec(name);
        if (!match || match[1] < oldest) continue;
        const file = path.join(where.root, peer, name);
        const key = `${peer}/${name}`;
        try {
          const info = await stat(file);
          const fingerprint = `${info.size}:${info.mtimeMs}`;
          const prior = known.get(key);
          if (prior === fingerprint) continue;
          // Partly applied before: retried only once this device has synced more videos.
          if (prior?.startsWith(`${fingerprint}|partial|`) && Number(prior.split("|")[2]) >= videoCount) continue;
          if (info.size > MAX_PEER_FILE_BYTES) {
            outcome.skipped.push({ file: key, reason: "too large" });
            known.set(key, fingerprint);
            changed = true;
            continue;
          }
          const parsed = analyticsDataFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
          // A file must describe the device and the day it is named after; anything else is not trusted (AC-AD-04).
          if (!parsed.success || parsed.data.deviceId !== peer || parsed.data.day !== match[1]) {
            outcome.skipped.push({ file: key, reason: parsed.success ? "names another device or day" : "invalid" });
            known.set(key, fingerprint);
            changed = true;
            continue;
          }
          const result = await deps.importRows(parsed.data.tables as AnalyticsShareTables);
          for (const channelId of result.incompleteChannels) incomplete.add(channelId);
          known.set(key, result.incompleteChannels.length > 0 ? `${fingerprint}|partial|${videoCount}` : fingerprint);
          changed = true;
          outcome.imported.push(key);
        } catch (error) {
          // A half-synced file: not marked as seen, so the next pass reads the finished one.
          outcome.skipped.push({ file: key, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    outcome.incompleteChannels = [...incomplete];
    if (changed) await deps.saveSeen(Object.fromEntries(known)).catch(() => undefined);
    if (outcome.skipped.length > 0) deps.log?.(`[analytics-data] skipped: ${outcome.skipped.map((s) => `${s.file} (${s.reason})`).join("; ")}`);
    return outcome;
  }

  return {
    /**
     * Writes this device's rows of today and yesterday (UTC) to its own day files -- only when they changed -- and deletes its
     * own files older than the window. Rows imported from another device keep their collection time, so they appear here too;
     * re-importing them there changes nothing.
     */
    publishLocal(): Promise<"published" | "unchanged" | "no_folder"> {
      // One at a time (review): two overlapping writes of one day file could leave the older content last.
      if (!publishing) publishing = publishOnce().finally(() => (publishing = null));
      return publishing;
    },

    /** The other devices' new rows in (AC-AD-01/02); concurrent callers share one pass. */
    importPeers(): Promise<ImportOutcome> {
      if (!importing) importing = importOnce().finally(() => (importing = null));
      return importing;
    },
  };

  async function publishOnce(): Promise<"published" | "unchanged" | "no_folder"> {
      const where = await folderOrNull();
      if (!where) return "no_folder";
      const now = deps.clock.now();
      const dir = path.join(where.root, where.deviceId);
      let wrote = false;
      for (const offset of [1, 0]) {
        const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offset * DAY_MS;
        const dayName = utcDay(start);
        const tables = await deps.exportRows(start / 1000, (start + DAY_MS) / 1000);
        if (isEmpty(tables)) continue;
        const digest = createHash("sha256").update(JSON.stringify(tables)).digest("hex");
        if (lastWritten.get(dayName) === digest) continue;
        await mkdir(dir, { recursive: true });
        await writeJsonFileAtomic(path.join(dir, `${dayName}.json`), { formatVersion: ANALYTICS_DATA_FORMAT_VERSION, deviceId: where.deviceId, day: dayName, writtenAt: now.toISOString(), tables });
        lastWritten.set(dayName, digest);
        wrote = true;
      }
      try {
        const oldest = utcDay(now.getTime() - ANALYTICS_DATA_WINDOW_DAYS * DAY_MS);
        for (const name of await readdir(dir)) {
          const match = DAY_FILE.exec(name);
          if (match && match[1] < oldest) await rm(path.join(dir, name), { force: true });
        }
      } catch {
        // nothing written yet
      }
      return wrote ? "published" : "unchanged";
  }
}

export type AnalyticsDataSync = ReturnType<typeof createAnalyticsDataSync>;
