// ---------------------------------------------------------------------------
// Shared leaf module (AGENTS.md §M): the ONE place inside an operator's channel workspace this
// product writes to -- `<workspace>/99 Data Exchange/From YTM` (owner decision 2026-10-04, ADR 0019
// amendment) -- resolved and proven safe the same way for every feature that uses it (research
// export since ADR 0019, media generation outputs since Phase 14 slice 3). Extracted from
// `src/lib/research-export/services.ts` (pure move: that module's tests are unchanged) so a second
// feature does not reach into the first one's services.
// ---------------------------------------------------------------------------

/** Buffer folders, not storage: each is created if missing, and the receiving side deletes what it has processed. */
export const DATA_EXCHANGE_DIR_NAME = "99 Data Exchange";
/** Manager -> project scripts (what this product writes). */
export const FROM_YTM_DIR_NAME = "From YTM";
/** Project -> Manager: job input files a channel passes to media generation (BL-132); read, never written or deleted here. */
export const SENT_TO_YTM_DIR_NAME = "Sent to YTM";

export type ExchangeFs = {
  realpath(p: string): Promise<string>;
  mkdir(p: string): Promise<void>;
  lstat(p: string): Promise<{ isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean } | null>;
};

/** BL-132: reading an input file also needs `stat` (follows symlinks; the caller has proven the real path is contained). */
export type ExchangeReadFs = ExchangeFs & { stat(p: string): Promise<{ isFile: boolean; size: number } | null> };

export type ResolveFromYtmDirArgs = {
  /** The operator-set workspace path (already looked up by the caller). */
  workspace: string;
  fs: ExchangeFs;
  /** `local-path-validation`'s set-time check, re-run at use time. */
  validateWorkspacePath(candidate: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** True when `child` is `parent` or inside it; both already `realpath`'d. */
  isPathInsideOrEqual(parent: string, child: string): boolean;
  /** The caller's own error for "configured, but cannot be used" (each feature keeps its own code). */
  unavailable(reason: string): Error;
};
