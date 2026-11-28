import { DomainError, isDomainError } from "@/lib/shared-domain";

/**
 * BL-279 (second review, finding 1): what a caller of `applyFieldsUpdate` needs to know about a failure that came after the write's
 * first irreversible step. `writeSent: true` -- the `videos.update` call was made (it may have landed even when it or the read-back
 * failed, e.g. a quota or reads-disabled error on the read-back); `backupPath` -- the backup taken before the write. A refusal before
 * the call (wrong channel, Live writes off, an etag conflict) carries neither `writeSent` nor, before the backup, `backupPath`.
 */
export type WriteErrorDetails = { writeSent?: true; backupPath?: string };

/** The same error with `extra` merged into its details (an existing key wins); a non-domain error becomes `update_failed`. */
export function withWriteErrorDetails(error: unknown, extra: WriteErrorDetails): DomainError {
  if (!isDomainError(error)) {
    return new DomainError({ code: "update_failed", message: error instanceof Error ? error.message : "Unknown error", details: { ...extra } });
  }
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? (error.details as Record<string, unknown>) : {};
  return new DomainError({ code: error.code, message: error.message, details: { ...extra, ...details } });
}
