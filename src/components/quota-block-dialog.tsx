"use client";

import { useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import { QuotaResetTime } from "./quota-reset-time";

/**
 * What the server said when it refused to START a write run because of quota (BL-117 slice 2, owner decisions 2026-10-03):
 * - `quota_insufficient`: the run needs more quota than is left (numbers + whether it can be split into what fits now and the rest);
 * - `quota_unknown`: the remaining quota cannot be read (typically Google Cloud is not connected).
 */
export type QuotaBlock =
  | {
      code: "quota_insufficient";
      estimatedUnits: number;
      remainingUnits: number;
      rowsToWrite: number;
      fitVideos: number;
      resetsAt: string | null;
      canSplit: boolean;
    }
  | { code: "quota_unknown"; estimatedUnits: number; rowsToWrite: number; cloudConnected: boolean };

export type SplitOutcome = { fitsBatchId: string | null; restBatchId: string | null; fitRows: number; restRows: number };

/** Parses the error body of a refused request into a `QuotaBlock`, or null when it is some other error. */
export function parseQuotaBlock(body: unknown): QuotaBlock | null {
  if (typeof body !== "object" || body === null) return null;
  const { error, details } = body as { error?: unknown; details?: unknown };
  const d = (typeof details === "object" && details !== null ? details : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (error === "quota_insufficient") {
    return {
      code: "quota_insufficient",
      estimatedUnits: num(d.estimatedUnits),
      remainingUnits: num(d.remainingUnits),
      rowsToWrite: num(d.rowsToWrite),
      fitVideos: num(d.fitVideos),
      resetsAt: typeof d.resetsAt === "string" ? d.resetsAt : null,
      canSplit: d.canSplit === true,
    };
  }
  if (error === "quota_unknown") {
    return { code: "quota_unknown", estimatedUnits: num(d.estimatedUnits), rowsToWrite: num(d.rowsToWrite), cloudConnected: d.cloudConnected === true };
  }
  return null;
}

/**
 * The popup shown instead of starting a write run that quota does not allow. Insufficient: says what is needed/available/when
 * it resets and (for a fresh batch) offers to prepare a smaller batch that fits plus a batch of the rest. Unknown: says Google
 * Cloud is not connected (or unreadable) with a Connect button, and a small "Run anyway" for the user who knowingly accepts it.
 */
export function QuotaBlockDialog({
  block,
  noun = "batch",
  onClose,
  onSplit,
  onRunAnyway,
  splitOutcome,
  onOpenBatch,
}: {
  block: QuotaBlock;
  /** "batch" or "Fix all": wording only. */
  noun?: string;
  onClose: () => void;
  /** Only passed when the run can be split (a fresh batch). Resolves with the outcome, or throws with a message. */
  onSplit?: () => Promise<SplitOutcome>;
  onRunAnyway?: () => void;
  /** Set by the parent after a successful split, to show the result. */
  splitOutcome?: SplitOutcome | null;
  onOpenBatch?: (batchId: string) => void;
}) {
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  async function handleSplit() {
    if (!onSplit) return;
    setSplitting(true);
    setSplitError(null);
    try {
      await onSplit();
    } catch (error) {
      setSplitError(error instanceof Error ? error.message : "Could not split the batch");
    } finally {
      setSplitting(false);
    }
  }

  if (splitOutcome) {
    return (
      <BlockingDialog label="Batches prepared" maxWidthClass="max-w-md">
        <p className="text-sm font-medium text-zinc-100">Smaller batches are ready</p>
        <ul className="space-y-1 text-xs text-zinc-300">
          {splitOutcome.fitsBatchId && <li>{splitOutcome.fitRows} video(s) fit the quota available now: a new batch is ready to run.</li>}
          {splitOutcome.restBatchId && <li>{splitOutcome.restRows} video(s) are saved in another new batch to run after the quota is back.</li>}
          <li className="text-zinc-500">The original batch was closed so no video can be written twice. Nothing was sent to YouTube.</li>
        </ul>
        <div className="flex justify-end gap-2">
          {splitOutcome.fitsBatchId && onOpenBatch && (
            <button
              onClick={() => onOpenBatch(splitOutcome.fitsBatchId as string)}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Open the batch that fits
            </button>
          )}
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            Close
          </button>
        </div>
      </BlockingDialog>
    );
  }

  if (block.code === "quota_unknown") {
    return (
      <BlockingDialog label="Quota cannot be checked" maxWidthClass="max-w-md">
        <p className="text-sm font-medium text-zinc-100">YouTube quota cannot be checked</p>
        <p className="text-xs text-zinc-400">
          {block.cloudConnected
            ? "Google Cloud did not return the remaining quota just now."
            : "Google Cloud is not connected, so the remaining quota is unknown."}{" "}
          This {noun} needs about {block.estimatedUnits.toLocaleString()} units ({block.rowsToWrite} video(s)). Without the check it could be
          cut off half way if the quota runs out.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {!block.cloudConnected && (
            <a
              href="/api/cloud-connection/start"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              Connect Google Cloud
            </a>
          )}
          {onRunAnyway && (
            <button onClick={onRunAnyway} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
              Run anyway
            </button>
          )}
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            Cancel
          </button>
        </div>
      </BlockingDialog>
    );
  }

  return (
    <BlockingDialog label="Not enough quota" maxWidthClass="max-w-md">
      <p className="text-sm font-medium text-zinc-100">Not enough YouTube quota for this {noun}</p>
      <p className="text-xs text-zinc-400">
        It needs about <span className="text-zinc-200">{block.estimatedUnits.toLocaleString()}</span> units ({block.rowsToWrite} video(s)), but only{" "}
        <span className="text-zinc-200">{block.remainingUnits.toLocaleString()}</span> are available
        {block.resetsAt ? <> (the quota resets <QuotaResetTime iso={block.resetsAt} />)</> : null}. It was not started, so nothing was written and
        nothing can be cut off half way.
      </p>
      {block.canSplit && onSplit ? (
        <p className="text-xs text-zinc-400">
          {block.fitVideos} video(s) fit right now. You can prepare a smaller batch of those, plus a new batch of the remaining{" "}
          {block.rowsToWrite - block.fitVideos} to run later.
        </p>
      ) : (
        <p className="text-xs text-zinc-500">
          {block.fitVideos > 0 ? `${block.fitVideos} video(s) would fit; ` : "Nothing fits right now; "}
          {noun === "batch" ? "a batch that already started cannot be split." : "select fewer videos or try again after the reset."}
        </p>
      )}
      {splitError && <p className="text-xs text-red-400">{splitError}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {block.canSplit && onSplit && (
          <button
            onClick={() => void handleSplit()}
            disabled={splitting}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {splitting ? "Preparing..." : `Prepare a batch of ${block.fitVideos} + a batch of the rest`}
          </button>
        )}
        <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          Close
        </button>
      </div>
    </BlockingDialog>
  );
}
