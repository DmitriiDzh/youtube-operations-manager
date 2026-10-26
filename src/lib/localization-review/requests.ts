// BL-227 stage 2 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §7a, FO-MSG-0025 §1): translation requests -- the owner asks, the
// channel's agent claims, hands in the sets it made, or fails with a reason. Pure parts here; `index.ts` wires the stores. A request
// never approves, rejects or sends anything.
import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";
import type { DraftTranslationRequest, TranslationRequestStatus } from "@/lib/sync-gateway";

/** FO-MSG-0025 §1: a request is overdue 3 h after it was made without a claim, or 3 h after the claim without a result. */
export const REQUEST_OVERDUE_MS = 3 * 60 * 60 * 1000;

export type TranslationRequestView = {
  requestId: string;
  videoIds: string[];
  languages: string[];
  mode: "fill_missing" | "redo";
  fields: "both" | "title" | "description";
  note: string | null;
  redoOfChangeId: string | null;
  status: TranslationRequestStatus;
  overdue: boolean;
  claimedBy: "factory" | "worker" | null;
  claimedAt: string | null;
  results: Array<{ videoId: string; changeSetId: string }>;
  failReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function parseArray<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

export function toRequestView(request: DraftTranslationRequest, nowMs: number): TranslationRequestView {
  const since = request.status === "requested" ? Date.parse(request.createdAt) : request.status === "in_progress" ? Date.parse(request.claimedAt ?? request.createdAt) : null;
  return {
    requestId: request.id,
    videoIds: parseArray<string>(request.videoIdsJson),
    languages: parseArray<string>(request.languagesJson),
    mode: request.mode,
    fields: request.fields,
    note: request.note,
    redoOfChangeId: request.redoOfChangeId,
    status: request.status,
    overdue: since !== null && !Number.isNaN(since) && nowMs - since > REQUEST_OVERDUE_MS,
    claimedBy: request.claimedBy,
    claimedAt: request.claimedAt,
    results: parseArray<{ videoId: string; changeSetId: string }>(request.resultJson),
    failReason: request.failReason,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

export const createRequestInputSchema = z
  .object({
    videoIds: z.array(z.string().min(1).max(64)).min(1).max(200),
    languages: z.array(z.string().min(1).max(35)).min(1).max(40),
    mode: z.enum(["fill_missing", "redo"]).default("fill_missing"),
    fields: z.enum(["both", "title", "description"]).default("both"),
    note: z.string().trim().max(1000).optional(),
    redoOfChangeId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const listRequestsInputSchema = z
  .object({ channelId: z.string().min(1).max(64), status: z.enum(["requested", "in_progress", "done", "partly_done", "failed", "cancelled"]).optional() })
  .strict();
export const requestRefInputSchema = z.object({ channelId: z.string().min(1).max(64), requestId: z.string().min(1).max(64) }).strict();
export const completeRequestInputSchema = z
  .object({
    channelId: z.string().min(1).max(64),
    requestId: z.string().min(1).max(64),
    results: z.array(z.object({ videoId: z.string().min(1).max(64), changeSetId: z.string().min(1).max(64) }).strict()).min(1).max(200),
  })
  .strict();
export const failRequestInputSchema = z
  .object({ channelId: z.string().min(1).max(64), requestId: z.string().min(1).max(64), reason: z.string().trim().min(1).max(1000) })
  .strict();

export function parseOrRefuse<T extends z.ZodTypeAny>(schema: T, input: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError({ code: "validation_failed", message: `Invalid ${what}`, details: { issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
  }
  return parsed.data;
}
