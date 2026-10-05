import path from "node:path";
import { DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, SENT_TO_YTM_DIR_NAME, resolveFromYtmDir } from "@/lib/workspace-exchange";
import {
  CHANNEL_SNAPSHOT_COLUMNS,
  DomainError,
  VIDEO_SNAPSHOT_COLUMNS,
  type ExportDataset,
  type ExportFormat,
  type ExportResearchDataResult,
  type ExportedFile,
  type ListResearchOverviewResult,
  type LedgerFileRecord,
  type OwnVideoForExport,
  type WatchlistContextForExport,
} from "./contracts";
import { toCsv, type CsvCell } from "./csv";
import { buildChannelSnapshotRows, buildOwnVideoRows, buildVideoSnapshotRows, computeResearchFileExpiry, summarizeVideoSnapshots } from "./rows";
import { exportResearchDataInputSchema, listResearchOverviewInputSchema, parseWithSchema } from "./schemas";

export type WorkspacePathValidationResult = { ok: true } | { ok: false; reason: string };

export type ResearchExportDeps = {
  now(): Date;
  /** 4 lowercase hex characters -- keeps two exports within the same second apart. */
  randomSuffix(): string;
  newId(): string;
  /** This device's workspace folder for the channel, `null` when the operator never set one. */
  getWorkspacePath(channelId: string): Promise<string | null>;
  validateWorkspacePath(candidate: string): Promise<WorkspacePathValidationResult>;
  /** True when `child` is `parent` or inside it; both already `realpath`'d (production: `local-path-validation`'s `isPathInsideOrEqual`). */
  isPathInsideOrEqual(parent: string, child: string): boolean;
  /** The watchlist channel ids the caller may see (already narrowed to the agent's channel assignments). */
  listWatchlistChannelIds(): Promise<string[]>;
  /** One watchlist channel's data; throws RESEARCH_CHANNEL_NOT_AVAILABLE when it is not on the watchlist or not visible to the caller. */
  getWatchlistContext(researchChannelId: string): Promise<WatchlistContextForExport>;
  getOwnChannel(channelId: string): Promise<{ channelId: string; title: string } | null>;
  listOwnVideos(channelId: string): Promise<OwnVideoForExport[]>;
  fs: {
    realpath(p: string): Promise<string>;
    mkdir(p: string): Promise<void>;
    lstat(p: string): Promise<{ isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean } | null>;
    /** Exclusive create: fails when the file already exists. */
    writeNewFile(p: string, data: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(p: string): Promise<void>;
  };
  ledger: {
    insert(record: LedgerFileRecord): Promise<void>;
    listExpired(now: Date): Promise<LedgerFileRecord[]>;
    markDeleted(id: string, at: Date): Promise<void>;
  };
};

// The ONE place inside the operator's channel workspace the Manager writes to (owner decision 2026-10-04, ADR 0019 amendment): a fixed,
// deliberate exception to "the Manager touches nothing in a project". Only research exports go here, and only files this module created
// are ever deleted from it. The folder resolution itself moved to the shared `workspace-exchange` module (AGENTS.md §M) once Phase 14's
// media outputs needed the same folder; the names are re-exported here unchanged.
export { DATA_EXCHANGE_DIR_NAME, FROM_YTM_DIR_NAME, SENT_TO_YTM_DIR_NAME };

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const RETENTION_NOTE =
  "research_* files hold other channels' public YouTube statistics: the Manager deletes each such file itself 30 days after the oldest observation in it (YouTube API policy III.E.4.d); treat any copy you make as short-lived too. own_video_snapshots holds our own channel and has no expiry.";

type Prepared = { dataset: ExportDataset; format: ExportFormat; fileName: string; content: string; rows: number; expiresAt: Date | null };

export function createResearchExportServices(deps: ResearchExportDeps) {
  /** Folder = <realpath(workspace)>/99 Data Exchange/From YTM, created if missing and proven (after symlink resolution) to still lie strictly inside the workspace. */
  async function resolveExportsDir(channelId: string): Promise<string> {
    const workspace = await deps.getWorkspacePath(channelId);
    if (!workspace) {
      throw new DomainError({
        code: "RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED",
        message: "This channel has no workspace folder on this device. The operator sets it in Settings -> Channels; an export is written only there.",
        details: { channelId },
      });
    }
    const unavailable = (reason: string) =>
      new DomainError({
        code: "RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE",
        message: `The channel's workspace folder cannot be used for an export: ${reason}`,
        details: { channelId, reason },
      });
    return resolveFromYtmDir({
      workspace,
      fs: deps.fs,
      validateWorkspacePath: deps.validateWorkspacePath,
      isPathInsideOrEqual: deps.isPathInsideOrEqual,
      unavailable,
    });
  }

  async function writeAll(dir: string, prepared: Prepared[]): Promise<ExportedFile[]> {
    const written: string[] = [];
    try {
      const out: ExportedFile[] = [];
      for (const file of prepared) {
        const finalPath = path.join(dir, file.fileName);
        const tmpPath = path.join(dir, `.${file.fileName}.tmp`);
        await deps.fs.writeNewFile(tmpPath, file.content);
        written.push(tmpPath);
        await deps.fs.rename(tmpPath, finalPath);
        written.splice(written.indexOf(tmpPath), 1, finalPath);
        out.push({
          dataset: file.dataset,
          format: file.format,
          path: finalPath,
          rows: file.rows,
          bytes: Buffer.byteLength(file.content, "utf8"),
          expiresAt: file.expiresAt?.toISOString() ?? null,
        });
      }
      return out;
    } catch (error) {
      for (const leftover of written) await deps.fs.unlink(leftover).catch(() => undefined);
      throw new DomainError({
        code: "RESEARCH_EXPORT_WRITE_FAILED",
        message: `Could not write the export files; nothing from this call was kept (${error instanceof Error ? error.message : String(error)})`,
        details: {},
      });
    }
  }

  return {
    async exportResearchData(input: unknown): Promise<ExportResearchDataResult> {
      const parsed = parseWithSchema(exportResearchDataInputSchema, input, "export research data input");
      const now = deps.now();

      // 1. Read everything first: a request naming an unavailable channel fails before the disk is touched.
      const exportsDir = await resolveExportsDir(parsed.channelId);
      const researchIds = parsed.researchChannelIds ?? (await deps.listWatchlistChannelIds());
      const contexts: WatchlistContextForExport[] = [];
      for (const id of [...new Set(researchIds)]) contexts.push(await deps.getWatchlistContext(id));

      const channelRows = buildChannelSnapshotRows(contexts);
      const videoRows = buildVideoSnapshotRows(contexts);
      const researchExpiry = computeResearchFileExpiry(contexts, now);
      const datasets: Array<{ dataset: ExportDataset; stem: string; columns: readonly string[]; rows: Array<Record<string, CsvCell>>; expiresAt: Date | null }> = [
        { dataset: "research_channel_snapshots", stem: "research-channel-snapshots", columns: CHANNEL_SNAPSHOT_COLUMNS, rows: channelRows, expiresAt: researchExpiry },
        { dataset: "research_video_snapshots", stem: "research-video-snapshots", columns: VIDEO_SNAPSHOT_COLUMNS, rows: videoRows, expiresAt: researchExpiry },
      ];
      if (parsed.includeOwnChannel) {
        const own = await deps.getOwnChannel(parsed.channelId);
        if (own) {
          const ownRows = buildOwnVideoRows(own, await deps.listOwnVideos(parsed.channelId));
          datasets.push({ dataset: "own_video_snapshots", stem: "own-video-snapshots", columns: VIDEO_SNAPSHOT_COLUMNS, rows: ownRows, expiresAt: null });
        }
      }

      // 2. Serialise, name (Manager-chosen: dataset + UTC time + random suffix, never a title or handle), write, then record in the ledger.
      const suffix = `${stamp(now)}-${deps.randomSuffix()}`;
      const prepared: Prepared[] = datasets.flatMap((d) =>
        parsed.formats.map((format) => ({
          dataset: d.dataset,
          format,
          fileName: `${d.stem}-${suffix}.${format}`,
          content: format === "csv" ? toCsv(d.columns, d.rows, d.columns.filter((c) => c === "title"), d.columns.filter((c) => c === "channel")) : `${JSON.stringify(d.rows, null, 2)}\n`,
          rows: d.rows.length,
          expiresAt: d.expiresAt,
        }))
      );
      // The ledger rows come FIRST: a file that exists on disk always has a row, so the sweep can always find it (a row whose file was never
      // written is harmless -- the sweep counts it as already gone). If recording fails nothing has been written yet.
      const records: LedgerFileRecord[] = prepared.map((file) => ({
        id: deps.newId(),
        channelId: parsed.channelId,
        exportsDir,
        fileName: file.fileName,
        dataset: file.dataset,
        format: file.format,
        rowCount: file.rows,
        createdAt: now,
        expiresAt: file.expiresAt,
      }));
      for (const record of records) await deps.ledger.insert(record);
      let files: ExportedFile[];
      try {
        files = await writeAll(exportsDir, prepared);
      } catch (error) {
        for (const record of records) await deps.ledger.markDeleted(record.id, now).catch(() => undefined);
        throw error;
      }

      return {
        generatedAt: now.toISOString(),
        exportsDir,
        files,
        watchlistChannels: {
          exported: contexts.length,
          withoutSnapshots: contexts.filter((c) => c.channelSnapshots.length === 0).map((c) => c.channel.channelId),
        },
        retentionNote: RETENTION_NOTE,
      };
    },

    /**
     * Compact bulk read: several watchlist channels in one call, paged, each with its newest raw channel snapshot and row counts -- the
     * values `query_market_intelligence` returns per channel, without its evidence text and snapshot lists. Nothing is computed from
     * competitor statistics (no ranking, rate or median: YouTube policy III.E.4.h, Phase 13 D1).
     */
    async listResearchOverview(input: unknown): Promise<ListResearchOverviewResult> {
      const parsed = parseWithSchema(listResearchOverviewInputSchema, input, "list research overview input");
      const ids = [...new Set(parsed.channelIds ?? (await deps.listWatchlistChannelIds()))];
      const page = ids.slice(parsed.offset, parsed.offset + parsed.limit);
      const channels = [];
      for (const id of page) {
        const context = await deps.getWatchlistContext(id);
        const latest = context.channelSnapshots.at(-1) ?? null;
        channels.push({
          channelId: context.channel.channelId,
          handleOrUrl: context.channel.handleOrUrl,
          latestChannelSnapshot: latest && {
            observedAt: latest.observedAt,
            subscriberCount: latest.subscriberCount,
            viewCount: latest.viewCount,
            videoCount: latest.videoCount,
            hiddenSubscriberCount: latest.hiddenSubscriberCount,
          },
          channelSnapshotCount: context.channelSnapshots.length,
          videoSnapshotCount: context.videoSnapshots.length,
          ...summarizeVideoSnapshots(context.videoSnapshots),
          evidenceCount: context.evidenceCount,
          dataQualityFlags: context.dataQualityFlags,
          collection: context.collectionProgress,
        });
      }
      const end = parsed.offset + page.length;
      return { total: ids.length, offset: parsed.offset, limit: parsed.limit, channels, nextOffset: end < ids.length ? end : null };
    },

    /**
     * Deletes the files this module itself wrote whose time has come (ledger rows only -- never a scan or glob of the operator's folder).
     * A recorded file that is already gone counts as deleted; anything that is no longer a plain file at its recorded place (replaced by a
     * symlink or folder) is left alone and reported.
     */
    async sweepExpiredExports(now: Date = deps.now()): Promise<{ deleted: number; alreadyGone: number; skipped: number }> {
      const result = { deleted: 0, alreadyGone: 0, skipped: 0 };
      for (const record of await deps.ledger.listExpired(now)) {
        const target = path.join(record.exportsDir, record.fileName);
        const leftoverTemp = path.join(record.exportsDir, `.${record.fileName}.tmp`);
        try {
          // The recorded folder must still be that very folder (not moved, not replaced by a link elsewhere).
          const dirNow = await deps.fs.realpath(record.exportsDir).catch(() => null);
          if (dirNow === null) {
            result.alreadyGone += 1;
            await deps.ledger.markDeleted(record.id, now);
            continue;
          }
          if (dirNow !== record.exportsDir) {
            result.skipped += 1;
            continue;
          }
          const info = await deps.fs.lstat(target);
          if (!info) {
            result.alreadyGone += 1;
          } else if (info.isFile && !info.isSymbolicLink) {
            await deps.fs.unlink(target);
            result.deleted += 1;
          } else {
            result.skipped += 1;
            continue;
          }
          const temp = await deps.fs.lstat(leftoverTemp); // a crash between write and rename can leave this behind
          if (temp && temp.isFile && !temp.isSymbolicLink) await deps.fs.unlink(leftoverTemp);
          await deps.ledger.markDeleted(record.id, now);
        } catch {
          result.skipped += 1;
        }
      }
      return result;
    },
  };
}

export type ResearchExportServices = ReturnType<typeof createResearchExportServices>;
