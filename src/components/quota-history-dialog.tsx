"use client";

import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { useEffect, useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import { QuotaResetTime } from "./quota-reset-time";
import { LoadingIndicator } from "./operation-progress";
import { formatTimeUntil } from "@/lib/quota-history/format";
import { translateWithSlots } from "./quota-block-dialog";
import { useUiText } from "./ui-text-provider";
import type { QuotaHistoryResult } from "@/lib/quota-history";

/**
 * BL-117 -- the quota-spend history popup (opened by the clock button next to a quota bar in Settings). One line per piece
 * of work (a batch of 45 translated videos is ONE line), newest first, plus when the quota resets and how much of Google's
 * usage this device's log does not explain (another device on the shared Cloud project, or calls the log missed).
 */
export function QuotaHistoryDialog({ service, onClose }: { service: "data" | "analytics"; onClose: () => void }) {
  const { t, formatNumber } = useUiText();
  const [data, setData] = useState<QuotaHistoryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/quota/history?service=${service}`);
        if (!res.ok) throw new Error("bad status"); // ui-text-ignore: internal, never shown
        const body = (await res.json()) as QuotaHistoryResult;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = t(service === "data" ? "quota.history.titleData" : "quota.history.titleAnalytics");

  return (
    <BlockingDialog label={title} maxWidthClass="max-w-2xl">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <button onClick={onClose} className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
          {t("common.close")}
        </button>
      </div>

      {failed && <p className="text-xs text-red-400">{t("quota.history.loadFailed")}</p>}
      {!data && !failed && <LoadingIndicator className="text-xs text-zinc-500" />}

      {data && (
        <>
          <div className="space-y-1 text-xs text-zinc-400">
            {data.cloud.connected && data.cloud.used !== null && data.cloud.limit !== null ? (
              <p>
                {translateWithSlots(t, data.cloud.window === "since_reset" ? "quota.history.usedSinceReset" : "quota.history.usedLast24h", {}, {
                  amount: (
                    <span className="text-zinc-200">
                      {formatNumber(data.cloud.used)} / {formatNumber(data.cloud.limit)}
                    </span>
                  ),
                })}
              </p>
            ) : (
              <p className="text-amber-400">{t("quota.history.cloudMissing")}</p>
            )}
            {data.cloud.resetsAt ? (
              <p>
                {translateWithSlots(t, "quota.history.resetsAt", {}, {
                  time: (
                    <span className="text-zinc-200">
                      <QuotaResetTime iso={data.cloud.resetsAt} />
                    </span>
                  ),
                  wait: <span className="text-zinc-200">{formatTimeUntil(Date.parse(data.cloud.resetsAt) - now)}</span>,
                })}
              </p>
            ) : (
              <p>{t("quota.history.resetUnknown")}</p>
            )}
          </div>

          {data.entries.length === 0 ? (
            <p className="text-sm text-zinc-500">{t("quota.history.empty")}</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto rounded-md border border-zinc-800 p-2 text-xs">
              {data.entries.map((entry) => (
                <li key={`${entry.kind}-${entry.contextId ?? ""}-${entry.startedAt}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-800/60 py-1 last:border-0">
                  <span className="text-zinc-500">{formatDisplayDateTime(entry.startedAt)}</span>
                  <span className="font-medium text-zinc-200">{entry.label}</span>
                  {entry.onOtherDevice && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{t("quota.history.otherDevice")}</span>}
                  <span className="text-zinc-400">
                    {entry.changedVideos !== null
                      ? t("quota.history.videosChanged", { count: entry.changedVideos })
                      : entry.writeCalls > 0
                        ? t("quota.history.changes", { count: entry.writeCalls })
                        : t("quota.history.calls", { count: entry.calls })}
                  </span>
                  <span className="ml-auto tabular-nums text-zinc-100">{t("quota.units", { count: entry.units })}</span>
                  {entry.failedCalls > 0 && <span className="text-amber-400">{t("quota.history.failed", { count: entry.failedCalls })}</span>}
                  {entry.unknownUnitCalls > 0 && <span className="text-zinc-500">{t("quota.history.unknownCost", { count: entry.unknownUnitCalls })}</span>}
                </li>
              ))}
              {data.otherUnits !== null && data.otherUnits > 0 && (
                <li className="flex gap-3 py-1 text-zinc-400">
                  <span>{t("quota.history.notAttributed")}</span>
                  <span className="ml-auto tabular-nums">{t("quota.units", { count: data.otherUnits })}</span>
                </li>
              )}
            </ul>
          )}
          <p className="text-[11px] text-zinc-600">{t("quota.history.footer")}</p>
        </>
      )}
    </BlockingDialog>
  );
}
