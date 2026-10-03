import { z } from "zod";

// BL-117 slice 1b (owner instruction, 2026-10-03): the quota-spend history is shared between devices because they spend ONE Cloud
// project's quota. Each device publishes its OWN log as `<syncthing root>/quota-ledger/<deviceId>.json` (single writer per
// file, like change drafts), and reads the other devices' files read-only. A replace-style snapshot would conflict forever:
// every device appends to its log constantly.

export const QUOTA_LEDGER_DIR_NAME = "quota-ledger";
export const QUOTA_LEDGER_FORMAT_VERSION = 1;
/** How far back a published file reaches (matches the local retention). */
export const QUOTA_LEDGER_WINDOW_DAYS = 45;
/** A peer file larger than this is ignored (a corrupted or hostile file must not exhaust memory). */
export const MAX_PEER_FILE_BYTES = 8 * 1024 * 1024;

/** One minute of one method's calls: the compact form that goes on disk. */
export const quotaLedgerRowSchema = z
  .object({
    /** Start of the minute, unix seconds. */
    t: z.number().int().nonnegative(),
    s: z.enum(["data", "analytics"]),
    m: z.string().min(1).max(120),
    o: z.enum(["ok", "error", "quota_exceeded"]),
    /** Sum of the KNOWN unit costs of the calls in this bucket. */
    u: z.number().int().nonnegative(),
    /** Calls in this bucket. */
    n: z.number().int().positive(),
    /** Of those, calls whose cost is unknown (not in `u`). */
    k: z.number().int().nonnegative(),
    ck: z.string().max(60).nullable(),
    ci: z.string().max(120).nullable(),
    cl: z.string().max(200).nullable(),
  })
  .strict();

export const quotaLedgerFileSchema = z
  .object({
    formatVersion: z.literal(QUOTA_LEDGER_FORMAT_VERSION),
    deviceId: z.string().min(1).max(100),
    writtenAt: z.string().max(40),
    rows: z.array(quotaLedgerRowSchema).max(500_000),
  })
  .strict();

export type QuotaLedgerRow = z.infer<typeof quotaLedgerRowSchema>;
export type QuotaLedgerFile = z.infer<typeof quotaLedgerFileSchema>;
