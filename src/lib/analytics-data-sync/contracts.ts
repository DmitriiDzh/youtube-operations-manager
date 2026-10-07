import { z } from "zod";

// BL-151 (owner, Telegram 2026-10-07, msgs 2004/2008; docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md): the analytics and reach
// rows each device collects, shared so the other computer neither lacks them nor fetches them again. Each device writes only its
// OWN files, one per UTC day of collection: `<Syncthing root>/analytics-data/<deviceId>/<YYYY-MM-DD>.json` (single writer, like
// the quota ledger and change drafts); the other devices read them read-only and merge (newer collection wins).

export const ANALYTICS_DATA_DIR_NAME = "analytics-data";
export const ANALYTICS_DATA_FORMAT_VERSION = 1;
/** Own files older than this are deleted; peers' older history stays in their databases. */
export const ANALYTICS_DATA_WINDOW_DAYS = 45;
/** A peer file larger than this is ignored (a corrupt or hostile file must not exhaust memory). */
export const MAX_PEER_FILE_BYTES = 64 * 1024 * 1024;

const id = z.string().min(1).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sec = z.number().int().nonnegative();

export const analyticsDataFileSchema = z
  .object({
    formatVersion: z.literal(ANALYTICS_DATA_FORMAT_VERSION),
    deviceId: z.string().min(1).max(100),
    day,
    writtenAt: z.string().max(40),
    tables: z
      .object({
        videoMetrics: z.array(z.tuple([id, id, z.string().max(20), z.string().max(80), z.number(), sec])).max(2_000_000),
        channelMetrics: z.array(z.tuple([id, z.string().max(20), z.string().max(80), z.number(), sec])).max(200_000),
        videoHistory: z.array(z.tuple([id, id, z.string().max(20), sec])).max(200_000),
        collectionRuns: z
          .array(
            z
              .object({ channelId: id, start: z.string().max(20), end: z.string().max(20), videoCount: z.number().int(), upserts: z.number().int(), skippedJson: z.string().max(1_000_000), ranAt: sec, channelLevel: z.number().int().nullable() })
              .strict()
          )
          .max(10_000),
        channelStamps: z.array(z.tuple([id, sec])).max(10_000),
        reportFiles: z
          .array(
            z
              .object({ reportId: id, channelId: id, reportTypeId: id, jobId: id, startTime: z.string().max(40), endTime: z.string().max(40), createTime: z.string().max(40), rowCount: z.number().int(), status: z.string().max(40), importedAt: sec })
              .strict()
          )
          .max(100_000),
        reachRows: z.array(z.tuple([id, z.string().max(20), id, z.number(), z.number().nullable(), id])).max(2_000_000),
        syncAttempts: z.array(z.object({ channelId: id, reportTypeId: id, attemptedAt: sec, outcome: z.string().max(40), filesListed: z.number().int(), filesImported: z.number().int() }).strict()).max(10_000),
        jobs: z.array(z.object({ channelId: id, reportTypeId: id, jobId: id, jobName: z.string().max(300), jobCreatedAt: z.string().max(40).nullable(), lastCheckedAt: sec.nullable() }).strict()).max(10_000),
      })
      .strict(),
  })
  .strict();

export type AnalyticsDataFile = z.infer<typeof analyticsDataFileSchema>;
