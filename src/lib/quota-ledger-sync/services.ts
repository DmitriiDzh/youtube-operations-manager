import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";
import { aggregateCallsForExport, rowsToCalls, type LocalCall } from "./aggregate";
import {
  MAX_PEER_FILE_BYTES,
  QUOTA_LEDGER_DIR_NAME,
  QUOTA_LEDGER_FORMAT_VERSION,
  QUOTA_LEDGER_WINDOW_DAYS,
  quotaLedgerFileSchema,
  type QuotaLedgerRow,
} from "./contracts";
import type { QuotaCallLike } from "@/lib/quota-history/grouping";

export type QuotaLedgerSyncDependencies = {
  /** This device's id and the Syncthing folder; `folder: null` = not configured. */
  getConfig(): Promise<{ deviceId: string; folder: string | null }>;
  /** This device's own calls since `sinceSeconds` (all services). */
  listLocalCalls(sinceSeconds: number): Promise<LocalCall[]>;
  clock: { now(): Date };
};

const SAFE_DEVICE_ID = /^[A-Za-z0-9._-]{1,100}$/;

export function createQuotaLedgerSyncServices(deps: QuotaLedgerSyncDependencies) {
  let lastPublishedDigest: string | null = null;

  return {
    /**
     * Writes THIS device's log to `<folder>/quota-ledger/<deviceId>.json` (atomically; only this device ever writes that file).
     * Never creates the Syncthing folder itself (an unplugged or renamed drive must not make a local folder no peer sees), does
     * nothing when the folder is missing, and skips the write when nothing changed since the last one. Returns what happened.
     */
    async publishLocal(): Promise<"published" | "unchanged" | "no_folder"> {
      const { deviceId, folder } = await deps.getConfig();
      if (!folder || !SAFE_DEVICE_ID.test(deviceId)) return "no_folder";
      try {
        if (!(await stat(folder)).isDirectory()) return "no_folder";
      } catch {
        return "no_folder";
      }

      const now = deps.clock.now();
      const sinceSeconds = Math.floor(now.getTime() / 1000) - QUOTA_LEDGER_WINDOW_DAYS * 86_400;
      const rows = aggregateCallsForExport(await deps.listLocalCalls(sinceSeconds));
      const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      if (digest === lastPublishedDigest) return "unchanged";

      const dir = path.join(folder, QUOTA_LEDGER_DIR_NAME);
      await mkdir(dir, { recursive: true });
      await writeJsonFileAtomic(path.join(dir, `${deviceId}.json`), {
        formatVersion: QUOTA_LEDGER_FORMAT_VERSION,
        deviceId,
        writtenAt: now.toISOString(),
        rows,
      });
      lastPublishedDigest = digest;
      return "published";
    },

    /**
     * The other devices' published calls since `sinceSeconds` for `service`, in the shape the history grouping reads. Read-only;
     * this device's own file is skipped; an unreadable, oversized, malformed or wrong-device file is ignored (never throws).
     */
    async readPeerCalls(args: { sinceSeconds: number; service: "data" | "analytics" }): Promise<QuotaCallLike[]> {
      const { deviceId, folder } = await deps.getConfig();
      if (!folder) return [];
      const dir = path.join(folder, QUOTA_LEDGER_DIR_NAME);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }

      const out: QuotaCallLike[] = [];
      for (const name of names) {
        const fileDeviceId = name.endsWith(".json") ? name.slice(0, -5) : null;
        if (!fileDeviceId || fileDeviceId === deviceId || !SAFE_DEVICE_ID.test(fileDeviceId)) continue;
        try {
          const file = path.join(dir, name);
          if ((await stat(file)).size > MAX_PEER_FILE_BYTES) continue;
          const parsed = quotaLedgerFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
          // A file must describe the device it is named after; anything else is not trusted.
          if (!parsed.success || parsed.data.deviceId !== fileDeviceId) continue;
          const rows: QuotaLedgerRow[] = parsed.data.rows.filter((r) => r.s === args.service && r.t >= args.sinceSeconds);
          out.push(...rowsToCalls(rows));
        } catch {
          // a half-synced or corrupt file: skip it, the next read sees the finished one
        }
      }
      return out;
    },
  };
}

export type QuotaLedgerSyncServices = ReturnType<typeof createQuotaLedgerSyncServices>;
