"use client";

import { useEffect, useRef, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { UiTextKey } from "@/lib/ui-text";
import { BlockingDialog } from "./blocking-dialog";
import { LoadingIndicator } from "./operation-progress";
import { useDialogFocus } from "./use-dialog-focus";
import { useUiText } from "./ui-text-provider";

// BL-194 stage 3 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 3, owner msgs 2870/2871): one total per video; a click opens this
// window with every run behind it -- RunPod and Gemini, tests, failed and rejected takes -- its cost (an estimate marked ≈), the
// RunPod pod start / idle share, and the computer that ran it. Read-only.

export type CostTotalsView = { runpodUsd: number; geminiUsd: number; totalUsd: number; runs: number; estimated: boolean };
type CostRunView = {
  runId: string;
  source: "runpod" | "gemini";
  kind: "job" | "session";
  label: string | null;
  storyboardId: string | null;
  storyboardVersion: number | null;
  segmentId: string | null;
  result: "chosen" | "rejected" | "failed" | "active" | "test" | "session";
  usd: number;
  basis: string;
  estimate: boolean;
  overheadUsd: number | null;
  gpuSeconds: number | null;
  createdAt: string;
  hostName: string | null;
  deviceId: string;
  thisComputer: boolean;
};
type CostComputerView = { deviceId: string; hostName: string | null; thisComputer: boolean; updatedAt: string | null };
type VideoCostView = { video: string; totals: CostTotalsView; runs: CostRunView[]; computers: CostComputerView[] };

/** Up to 4 decimals (a RunPod share is split to 1/10000 USD), at least 2. */
/** BL-221 (CONTENT_UX_PLAN.md stage B): totals in cents; a positive amount under a cent is «<$0.01», never «$0.00». */
export function costUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** One run's own share, where fractions of a cent matter: up to 4 decimals, trailing zeros past the cents dropped. */
export function costUsdPrecise(value: number): string {
  const fixed = value.toFixed(4);
  return `$${fixed.replace(/(\.\d\d\d?)0+$/, "$1").replace(/(\.\d\d)0$/, "$1")}`;
}

const RESULT_STYLE: Record<CostRunView["result"], string> = {
  chosen: "bg-emerald-950/60 text-emerald-300",
  rejected: "bg-zinc-800 text-zinc-400",
  failed: "bg-red-950/50 text-red-300",
  active: "bg-indigo-950/60 text-indigo-200",
  test: "bg-zinc-800 text-zinc-300",
  session: "bg-amber-950/40 text-amber-200",
};

export function VideoCostDialog({ channelId, video, workingTitle, onClose }: { channelId: string; video: string; workingTitle: string | null; onClose: () => void }) {
  const { t } = useUiText();
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref);
  const [data, setData] = useState<VideoCostView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/video-costs/${encodeURIComponent(video)}`);
        if (!res.ok) throw new Error("bad status"); // ui-text-ignore: internal, never shown
        const body = (await res.json()) as VideoCostView;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, video]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = t("videoCosts.dialogTitle", { video });
  const computerName = (c: { hostName: string | null }) => c.hostName ?? t("videoCosts.unknownComputer");
  const money = (usd: number, estimate: boolean) => `${estimate ? "≈" : ""}${costUsd(usd)}`;

  return (
    <BlockingDialog label={title} maxWidthClass="max-w-4xl">
      <div ref={ref} className="space-y-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-100">{title}</p>
            {workingTitle && <p className="truncate text-xs text-zinc-400">{workingTitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="ml-auto shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
            {t("common.close")}
          </button>
        </div>

        {failed && <p className="text-xs text-red-400">{t("videoCosts.detailFailed")}</p>}
        {!data && !failed && <LoadingIndicator className="text-xs text-zinc-400" />}
        {data && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["videoCosts.runpod", data.totals.runpodUsd],
                  ["videoCosts.gemini", data.totals.geminiUsd],
                  ["videoCosts.all", data.totals.totalUsd],
                ] as const
              ).map(([key, amount], i) => (
                <div key={key} className={`rounded-lg border px-3 py-2 ${i === 2 ? "border-indigo-800/70 bg-indigo-950/30" : "border-zinc-800 bg-zinc-950/40"}`}>
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">{t(key)}</p>
                  <p className="font-mono text-sm text-zinc-100">{money(amount, data.totals.estimated)}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-zinc-400">
              {t("videoCosts.runs", { runs: data.totals.runs })}
              {" · "}
              {t("videoCosts.computers", {
                list: data.computers.map((c) => (c.thisComputer ? t("videoCosts.computerHere", { name: computerName(c) }) : t("videoCosts.computerReport", { name: computerName(c), date: c.updatedAt ? formatDisplayDateTime(c.updatedAt) : "—" }))).join(", "),
              })}
            </p>
            {data.totals.estimated && <p className="text-xs text-amber-200/80">{t("videoCosts.estimatedNote")}</p>}
            {data.runs.length === 0 ? (
              <p className="text-xs text-zinc-400">{t("videoCosts.empty")}</p>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-zinc-800">
                <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-3 border-b border-zinc-800 bg-zinc-950/60 px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500 md:grid">
                  <span>{t("videoCosts.col.run")}</span>
                  <span>{t("videoCosts.col.segment")}</span>
                  <span>{t("videoCosts.col.result")}</span>
                  <span className="text-right">{t("videoCosts.col.cost")}</span>
                  <span>{t("videoCosts.col.computer")}</span>
                </div>
                <ul className="divide-y divide-zinc-800">
                  {data.runs.map((run) => (
                    <li key={`${run.deviceId}:${run.runId}`} className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-xs md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:items-start">
                      <div className="col-span-2 min-w-0 md:col-span-1">
                        <p className="text-zinc-200">{t(run.kind === "session" ? "videoCosts.kind.session" : run.source === "runpod" ? "videoCosts.kind.runpod" : "videoCosts.kind.gemini")}</p>
                        {run.label && <p className="truncate text-zinc-400" title={run.label}>{run.label}</p>}
                        <p className="text-zinc-500">{formatDisplayDateTime(run.createdAt)}</p>
                      </div>
                      <p className="min-w-0 truncate font-mono text-zinc-400">
                        {run.storyboardId && run.segmentId ? t("videoCosts.segment", { storyboard: run.storyboardId, version: run.storyboardVersion ?? "?", segment: run.segmentId }) : t("videoCosts.noSegment")}
                      </p>
                      <p>
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${RESULT_STYLE[run.result]}`}>{t(`videoCosts.result.${run.result}` as UiTextKey)}</span>
                      </p>
                      <div className="md:text-right">
                        <p className="font-mono text-zinc-100">{`${run.estimate ? "≈" : ""}${costUsdPrecise(run.usd)}`}</p>
                        <p className="text-zinc-500">{t(`videoCosts.basis.${run.basis}` as UiTextKey)}</p>
                        {run.source === "runpod" && run.overheadUsd !== null && run.overheadUsd > 0 && run.kind === "job" && <p className="text-zinc-500">{t("videoCosts.overhead", { amount: costUsdPrecise(run.overheadUsd) })}</p>}
                        {run.gpuSeconds !== null && run.kind === "job" && <p className="text-zinc-500">{t("videoCosts.gpuSeconds", { seconds: Math.round(run.gpuSeconds) })}</p>}
                      </div>
                      <p className="min-w-0 truncate text-zinc-400">{run.thisComputer ? t("videoCosts.computerHere", { name: computerName(run) }) : computerName(run)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </BlockingDialog>
  );
}
