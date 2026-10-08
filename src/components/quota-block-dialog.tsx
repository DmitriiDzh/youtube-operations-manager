"use client";

import { Fragment, useState, type ReactNode } from "react";
import type { Translate, UiTextKey, UiTextParams } from "@/lib/ui-text";
import { BlockingDialog } from "./blocking-dialog";
import { QuotaResetTime } from "./quota-reset-time";
import { useUiText } from "./ui-text-provider";

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

const SLOT = "\u0000";

/**
 * BL-152: one translated sentence with React elements inside it (a highlighted number, a reset time): each slot name is a
 * placeholder in the key's text, so the sentence stays whole and each language places the element where its grammar wants.
 */
export function translateWithSlots(t: Translate, key: UiTextKey, params: UiTextParams, slots: Record<string, ReactNode>): ReactNode[] {
  const markers = Object.fromEntries(Object.keys(slots).map((name) => [name, `${SLOT}${name}${SLOT}`]));
  return t(key, { ...params, ...markers })
    .split(SLOT)
    .map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{slots[part]}</Fragment> : part));
}

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
  noun = "batch", // ui-text-ignore: variant discriminator, not shown
  onClose,
  onSplit,
  onRunAnyway,
  splitOutcome,
  onOpenBatch,
}: {
  block: QuotaBlock;
  /** "batch" or "Fix all": picks the wording variant (BL-152: each variant has its own whole-sentence keys). */
  noun?: string;
  onClose: () => void;
  /** Only passed when the run can be split (a fresh batch). Resolves with the outcome, or throws with a message. */
  onSplit?: () => Promise<SplitOutcome>;
  onRunAnyway?: () => void;
  /** Set by the parent after a successful split, to show the result. */
  splitOutcome?: SplitOutcome | null;
  onOpenBatch?: (batchId: string) => void;
}) {
  const { t, formatNumber } = useUiText();
  const isBatch = noun === "batch"; // ui-text-ignore: variant discriminator, not shown
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);

  async function handleSplit() {
    if (!onSplit) return;
    setSplitting(true);
    setSplitError(null);
    try {
      await onSplit();
    } catch (error) {
      setSplitError(error instanceof Error ? error.message : t("quota.block.splitFailed"));
    } finally {
      setSplitting(false);
    }
  }

  if (splitOutcome) {
    return (
      <BlockingDialog label={t("quota.split.label")} maxWidthClass="max-w-md">
        <p className="text-sm font-medium text-zinc-100">{t("quota.split.title")}</p>
        <ul className="space-y-1 text-xs text-zinc-300">
          {splitOutcome.fitsBatchId && <li>{t("quota.split.fits", { count: splitOutcome.fitRows })}</li>}
          {splitOutcome.restBatchId && <li>{t("quota.split.rest", { count: splitOutcome.restRows })}</li>}
          <li className="text-zinc-500">{t("quota.split.originalClosed")}</li>
        </ul>
        <div className="flex justify-end gap-2">
          {splitOutcome.fitsBatchId && onOpenBatch && (
            <button
              onClick={() => onOpenBatch(splitOutcome.fitsBatchId as string)}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              {t("quota.split.openFitting")}
            </button>
          )}
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            {t("common.close")}
          </button>
        </div>
      </BlockingDialog>
    );
  }

  if (block.code === "quota_unknown") {
    return (
      <BlockingDialog label={t("quota.unknown.label")} maxWidthClass="max-w-md">
        <p className="text-sm font-medium text-zinc-100">{t("quota.unknown.title")}</p>
        <p className="text-xs text-zinc-400">
          {block.cloudConnected ? t("quota.unknown.cloudNoAnswer") : t("quota.unknown.cloudNotConnected")}{" "}
          {t(isBatch ? "quota.unknown.needsBatch" : "quota.unknown.needsFixAll", { units: block.estimatedUnits, count: block.rowsToWrite })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {!block.cloudConnected && (
            <a
              href="/api/cloud-connection/start"
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              {t("quota.connectCloud")}
            </a>
          )}
          {onRunAnyway && (
            <button onClick={onRunAnyway} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
              {t("quota.unknown.runAnyway")}
            </button>
          )}
          <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            {t("common.cancel")}
          </button>
        </div>
      </BlockingDialog>
    );
  }

  return (
    <BlockingDialog label={t("quota.insufficient.label")} maxWidthClass="max-w-md">
      <p className="text-sm font-medium text-zinc-100">{t(isBatch ? "quota.insufficient.titleBatch" : "quota.insufficient.titleFixAll")}</p>
      <p className="text-xs text-zinc-400">
        {translateWithSlots(t, block.resetsAt ? "quota.insufficient.needsWithReset" : "quota.insufficient.needs", { count: block.rowsToWrite }, {
          units: <span className="text-zinc-200">{formatNumber(block.estimatedUnits)}</span>,
          remaining: <span className="text-zinc-200">{formatNumber(block.remainingUnits)}</span>,
          ...(block.resetsAt ? { time: <QuotaResetTime iso={block.resetsAt} /> } : {}),
        })}
      </p>
      {block.canSplit && onSplit ? (
        <p className="text-xs text-zinc-400">{t("quota.insufficient.canSplit", { count: block.fitVideos, rest: block.rowsToWrite - block.fitVideos })}</p>
      ) : (
        <p className="text-xs text-zinc-500">
          {block.fitVideos > 0
            ? t(isBatch ? "quota.insufficient.wouldFitBatch" : "quota.insufficient.wouldFitFixAll", { count: block.fitVideos })
            : t(isBatch ? "quota.insufficient.nothingFitsBatch" : "quota.insufficient.nothingFitsFixAll")}
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
            {splitting ? t("quota.insufficient.preparing") : t("quota.insufficient.prepareSplit", { count: block.fitVideos })}
          </button>
        )}
        <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          {t("common.close")}
        </button>
      </div>
    </BlockingDialog>
  );
}
