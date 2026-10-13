"use client";

import { useCallback, useEffect, useState } from "react";
import { isCancellable } from "@/lib/publishing/upload-runner";
import { formatDisplayDateTime, formatDisplayDateUtc } from "@/lib/shared-formatting";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";
import { useUtcLocalHint } from "./utc-time-field";

type UploadRow = {
  id: string;
  video: string;
  status: "queued" | "uploading" | "processing" | "finishing" | "paused" | "done" | "failed" | "cancelled";
  resumeStatus: string | null;
  pausedReason: "live_writes_off" | "quota_exceeded" | "upload_limit" | "auth" | null;
  pausedUntil: string | null;
  publishAt: string | null;
  totalBytes: number;
  storedBytes: number;
  videoId: string | null;
  stepsJson: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

const ACTIVE = new Set(["queued", "uploading", "processing", "finishing", "paused"]);
const FAILED_KEYS = new Set(["unknown_outcome", "package_changed", "processing_rejected", "processing_failed", "WRITE_CHANNEL_MISMATCH"]);
const STATUS_STYLE: Record<UploadRow["status"], string> = {
  queued: "bg-zinc-800 text-zinc-300",
  uploading: "bg-indigo-950/60 text-indigo-200",
  processing: "bg-indigo-950/60 text-indigo-200",
  finishing: "bg-indigo-950/60 text-indigo-200",
  paused: "bg-amber-950/40 text-amber-200",
  done: "bg-emerald-950/50 text-emerald-300",
  failed: "bg-red-950/50 text-red-300",
  cancelled: "bg-zinc-800 text-zinc-500",
};

function PublishTime({ publishAt }: { publishAt: string }) {
  const t = useT();
  const time = publishAt.slice(11, 16);
  const hint = useUtcLocalHint(time, { on: new Date(publishAt) });
  return (
    <span>
      {formatDisplayDateUtc(publishAt)} {t("publishingUploads.publishAt", { time })}
      {hint && (
        <span className="ml-1 text-zinc-500" title={hint.title}>
          {hint.text}
        </span>
      )}
    </span>
  );
}

/**
 * BL-182 stage 2: this computer's uploads of the channel -- queued, sending (with its share), processing, finishing, paused (and
 * why, and when it continues by itself), done (with anything the read-back found) or failed. Polled while one is active. An
 * upload that has not reached YouTube can be cancelled.
 */
export function PublishingUploads({ channelId, visible, refreshKey }: { channelId: string | null; visible: boolean; refreshKey: number }) {
  const t = useT();
  const [rows, setRows] = useState<UploadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/uploads`);
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("publishingPackages.loadFailed")));
      setRows(data.uploads as UploadRow[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingPackages.loadFailed"));
    }
  }, [channelId, t]);

  const active = (rows ?? []).some((row) => ACTIVE.has(row.status));
  useEffect(() => {
    if (!visible) return;
    void load();
    const id = setInterval(() => void load(), active ? 5_000 : 30_000);
    return () => clearInterval(id);
  }, [visible, load, active, refreshKey]);

  async function cancel(id: string) {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/uploads/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("publishingUploads.cancelFailed")));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingUploads.cancelFailed"));
    }
  }

  if (!channelId || rows === null || (rows.length === 0 && !error)) {
    return rows !== null && channelId ? <p className="text-xs text-zinc-500">{t("publishingUploads.empty")}</p> : null;
  }

  const detail = (row: UploadRow): string | null => {
    const steps = (() => {
      try {
        return JSON.parse(row.stepsJson) as { verify?: { mismatches?: string[] }; notes?: string[] };
      } catch {
        return {};
      }
    })();
    if (row.status === "paused" && row.pausedReason) {
      return t(`publishingUploads.pause.${row.pausedReason}` as UiTextKey, { time: row.pausedUntil ? formatDisplayDateTime(row.pausedUntil) : "" });
    }
    if (row.status === "failed") {
      // The known reasons in the interface language; anything else as the server said it.
      const reason = row.errorMessage?.replace(/^YouTube \w+ the video: /, "") ?? "";
      return row.errorCode && FAILED_KEYS.has(row.errorCode) ? t(`publishingUploads.failed.${row.errorCode}` as UiTextKey, { reason }) : row.errorMessage;
    }
    if (row.status === "done" && row.errorCode === "verify_mismatch") return t("publishingUploads.result.verify_mismatch", { fields: (steps.verify?.mismatches ?? []).join(", ") });
    if (row.status === "done" && row.errorCode === "step_failed") return t("publishingUploads.result.step_failed", { notes: (steps.notes ?? []).join("; ") });
    if (row.status === "done" && row.errorCode === "publish_at_too_soon") return t("publishingUploads.result.publish_at_too_soon");
    return null;
  };

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-zinc-200">{t("publishingUploads.title")}</h4>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
        {rows.map((row) => {
          const percent = row.totalBytes > 0 ? Math.floor((row.storedBytes / row.totalBytes) * 100) : 0;
          const text = detail(row);
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
              <span className="font-mono text-zinc-400">{row.video}</span>
              <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLE[row.status]}`}>
                {t(`publishingUploads.status.${row.status}` as UiTextKey, { percent })}
              </span>
              {row.publishAt && (
                <span className="text-zinc-400">
                  <PublishTime publishAt={row.publishAt} />
                </span>
              )}
              {row.videoId && (
                <a href={`https://studio.youtube.com/video/${encodeURIComponent(row.videoId)}/edit`} target="_blank" rel="noreferrer" className="text-zinc-400 underline hover:text-zinc-200">
                  {t("publishingPackages.openOnYoutube")}
                </a>
              )}
              {isCancellable(row) && (
                <button type="button" onClick={() => void cancel(row.id)} className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800">
                  {t("publishingUploads.cancel")}
                </button>
              )}
              {text && <p className={`w-full ${row.status === "failed" || row.errorCode ? "text-amber-200" : "text-zinc-400"}`}>{text}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
