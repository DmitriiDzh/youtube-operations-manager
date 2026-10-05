import { z } from "zod";
export { parseWithSchema, formatZodError } from "./contracts";

/** `.strict()`: an extra field (a `path`, a `fileName`) is rejected, never ignored -- the agent has no say over where or under what name files land. */
export const exportResearchDataInputSchema = z
  .object({
    /** The caller's active channel: its workspace folder receives the files. */
    channelId: z.string().min(1).max(64),
    /** Research (watchlist) channels to export. Omitted = every watchlist channel the caller may see. */
    researchChannelIds: z.array(z.string().min(1).max(64)).min(1).max(200).optional(),
    /** Also write our own channel's public videos in the same columns. */
    includeOwnChannel: z.boolean().default(true),
    /** `csv` is spreadsheet-safe text (formula-leading text gets an apostrophe); `json` keeps every value exactly as stored. */
    formats: z.array(z.enum(["csv", "json"])).min(1).max(2).default(["csv"]),
  })
  .strict();

export type ExportResearchDataInput = z.infer<typeof exportResearchDataInputSchema>;

/** Compact bulk read of the watchlist (several channels in one call, paged). Local read; nothing is written. */
export const listResearchOverviewInputSchema = z
  .object({
    /** Omitted = every watchlist channel the caller may see. */
    channelIds: z.array(z.string().min(1).max(64)).min(1).max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export type ListResearchOverviewInput = z.infer<typeof listResearchOverviewInputSchema>;
