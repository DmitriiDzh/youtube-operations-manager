"use client";

import { useEffect, useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import { LoadingIndicator } from "./operation-progress";
import { formatTimeUntil } from "@/lib/quota-history/format";
import type { QuotaHistoryResult } from "@/lib/quota-history";

/**
 * BL-117 -- the quota-spend history popup (opened by the clock button next to a quota bar in Settings). One line per piece
 * of work (a batch of 45 translated videos is ONE line), newest first, plus when the quota resets and how much of Google's
 * usage this device's log does not explain (another device on the shared Cloud project, or calls the log missed).
 */
export function QuotaHistoryDialog({ service, onClose }: { service: "data" | "analytics"; onClose: () => void }) {
  const [data, setData] = useState<QuotaHistoryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/quota/history?service=${service}`);
        if (!res.ok) throw new Error("bad status");
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

  const title = service === "data" ? "YouTube Data API quota history" : "YouTube Analytics API quota history";

  return (
    <BlockingDialog label={title} maxWidthClass="max-w-2xl">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <button onClick={onClose} className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
          Close
        </button>
      </div>

      {failed && <p className="text-xs text-red-400">Could not load the history.</p>}
      {!data && !failed && <LoadingIndicator className="text-xs text-zinc-500" />}

      {data && (
        <>
          <div className="space-y-1 text-xs text-zinc-400">
            {data.cloud.connected && data.cloud.used !== null && data.cloud.limit !== null ? (
              <p>
                Used {data.cloud.window === "since_reset" ? "since the last reset" : "in the last 24 hours"}:{" "}
                <span className="text-zinc-200">{data.cloud.used.toLocaleString()} / {data.cloud.limit.toLocaleString()}</span> units
              </p>
            ) : (
              <p className="text-amber-400">Google Cloud is not connected (or did not answer), so Google&apos;s own usage figure is not shown.</p>
            )}
            {data.cloud.resetsAt ? (
              <p>
                Quota resets at <span className="text-zinc-200">{new Date(data.cloud.resetsAt).toLocaleString()}</span> (midnight Pacific
                Time), in <span className="text-zinc-200">{formatTimeUntil(Date.parse(data.cloud.resetsAt) - now)}</span>.
              </p>
            ) : (
              <p>Reset time for this API is not confirmed.</p>
            )}
          </div>

          {data.entries.length === 0 ? (
            <p className="text-sm text-zinc-500">
              Nothing recorded yet. Quota spending is logged from now on; earlier calls cannot be reconstructed.
            </p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-auto rounded-md border border-zinc-800 p-2 text-xs">
              {data.entries.map((entry) => (
                <li key={`${entry.kind}-${entry.contextId ?? ""}-${entry.startedAt}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-800/60 py-1 last:border-0">
                  <span className="text-zinc-500">{new Date(entry.startedAt).toLocaleString()}</span>
                  <span className="font-medium text-zinc-200">{entry.label}</span>
                  <span className="text-zinc-400">
                    {entry.changedVideos !== null
                      ? `${entry.changedVideos} video(s) changed`
                      : entry.writeCalls > 0
                        ? `${entry.writeCalls} change(s)`
                        : `${entry.calls} call(s)`}
                  </span>
                  <span className="ml-auto tabular-nums text-zinc-100">{entry.units.toLocaleString()} units</span>
                  {entry.failedCalls > 0 && <span className="text-amber-400">{entry.failedCalls} failed</span>}
                  {entry.unknownUnitCalls > 0 && <span className="text-zinc-500">{entry.unknownUnitCalls} of unknown cost</span>}
                </li>
              ))}
              {data.otherUnits !== null && data.otherUnits > 0 && (
                <li className="flex gap-3 py-1 text-zinc-400">
                  <span>Other device or not attributed</span>
                  <span className="ml-auto tabular-nums">{data.otherUnits.toLocaleString()} units</span>
                </li>
              )}
            </ul>
          )}
          <p className="text-[11px] text-zinc-600">
            Costs come from Google&apos;s published quota table; a failed call is counted as 1 unit at least. The log covers this computer;
            the Google figure covers the whole Cloud project.
          </p>
        </>
      )}
    </BlockingDialog>
  );
}
