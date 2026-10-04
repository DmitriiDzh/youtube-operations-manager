"use client";

import { useRef, useState } from "react";
import { runBatchWithProgress } from "./batch-run";
import { OperationOverlay, useOperation } from "./operation-progress";
import { QuotaBlockDialog, type QuotaBlock, type SplitOutcome } from "./quota-block-dialog";

type ApiError = { error?: string; message?: string; details?: { batchId?: string } };

/**
 * ADR 0020 / BL-124: "Send approved to YouTube" for one change set, on the Languages tab. One click:
 *  1. `POST .../change-sets/[id]/send` -- the server picks the set's sendable changes and creates a LIVE batch
 *     (refused with `live_writes_disabled`, creating nothing, when the Settings toggle is off);
 *  2. the EXISTING `batches/[id]/execute` route runs it -- identity check, backup, pre-write conflict check,
 *     read-back verification, quota guard, Live-writes Layer 1/2 are all unchanged;
 *  3. the shared progress pop-up (`runBatchWithProgress`) shows rows done/total, failures and Cancel.
 * A batch left PENDING by an earlier interrupted click is picked up (`send_already_in_progress` carries its id).
 * The resulting batch and its log stay on the Batches tab.
 */
export function SendApprovedButton({
  channelId,
  changeSetId,
  approvedCount,
  onFinished,
}: {
  channelId: string;
  changeSetId: string;
  approvedCount: number;
  /** Called after a run ended, so the parent can refresh its view. */
  onFinished?: () => void;
}) {
  const op = useOperation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const runningBatchIdRef = useRef<string | null>(null);
  const [quotaBlock, setQuotaBlock] = useState<{ batchId: string; block: QuotaBlock } | null>(null);
  const [splitOutcome, setSplitOutcome] = useState<SplitOutcome | null>(null);

  const batchBase = `/api/channels/${encodeURIComponent(channelId)}/batches`;

  async function execute(batchId: string, acknowledgeUnknownQuota = false) {
    runningBatchIdRef.current = batchId;
    try {
      const result = await runBatchWithProgress({
        channelId,
        batchId,
        kind: "execute",
        op,
        title: "Sending approved changes to YouTube",
        failureMessage: "Failed to send the approved changes",
        acknowledgeUnknownQuota,
        failOnUnwrittenRows: true,
      });
      if (result.kind === "quota_block") {
        setSplitOutcome(null);
        setQuotaBlock({ batchId, block: result.block });
      }
    } finally {
      runningBatchIdRef.current = null;
      onFinished?.();
    }
  }

  async function send() {
    // A ref, not only state: two clicks in the same tick must still start one run.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      op.start({ title: "Sending approved changes to YouTube", cancellable: false });
      op.setStage("Selecting the approved changes");
      let batchId: string | null = null;
      try {
        const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}/send`, {
          method: "POST",
        });
        const data = (await res.json()) as ApiError & { batchId?: string };
        if (res.ok) {
          batchId = data.batchId ?? null;
        } else if (data.error === "send_already_in_progress" && data.details?.batchId) {
          // An earlier click created the batch but it never finished: continue that one, never create another.
          batchId = data.details.batchId;
        } else if (data.error === "live_writes_disabled") {
          op.finish({ error: true, message: "Live writes is off — nothing was sent. Turn on “Live writes” in Settings, then send again." });
          return;
        } else {
          op.finish({ error: true, message: data.message ?? "Could not prepare the batch — nothing was sent." });
          return;
        }
      } catch (e) {
        op.finish({ error: true, message: e instanceof Error ? e.message : "Could not prepare the batch — nothing was sent." });
        return;
      }
      if (batchId) await execute(batchId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function cancel() {
    const batchId = runningBatchIdRef.current;
    op.requestCancel();
    if (!batchId) return;
    void fetch(`${batchBase}/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  async function split(batchId: string): Promise<SplitOutcome> {
    const res = await fetch(`${batchBase}/${encodeURIComponent(batchId)}/split-for-quota`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error((data as ApiError).message ?? "Could not split the batch");
    const outcome = data as SplitOutcome;
    setSplitOutcome(outcome);
    return outcome;
  }

  return (
    <>
      <button
        onClick={() => void send()}
        disabled={busy || approvedCount === 0}
        title={approvedCount === 0 ? "Approve at least one change first" : "Writes the approved changes to YouTube (same safety checks as a batch)"}
        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
      >
        Send approved to YouTube ({approvedCount})
      </button>
      <OperationOverlay state={op.state} onCancel={cancel} onClose={op.reset} />
      {quotaBlock && (
        <QuotaBlockDialog
          block={quotaBlock.block}
          splitOutcome={splitOutcome}
          onClose={() => {
            setQuotaBlock(null);
            setSplitOutcome(null);
          }}
          onSplit={quotaBlock.block.code === "quota_insufficient" && quotaBlock.block.canSplit ? () => split(quotaBlock.batchId) : undefined}
          onRunAnyway={
            quotaBlock.block.code === "quota_unknown"
              ? () => {
                  const batchId = quotaBlock.batchId;
                  setQuotaBlock(null);
                  void execute(batchId, true);
                }
              : undefined
          }
        />
      )}
    </>
  );
}
