"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateUtc } from "@/lib/shared-formatting";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";
import { useUtcLocalHint } from "./utc-time-field";
import { formatBytes } from "./volume-usage-bar";

type Problem = { code: string; params?: Record<string, string | number> };
type PackageRow = {
  manifestPath: string;
  video: string | null;
  title: string | null;
  plannedPublishDate: string | null;
  thumbnailPath: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  state: "not_ready" | "ready" | "uploaded_private" | "scheduled" | "published" | "uploaded_unknown";
  problems: Problem[];
  youtube: { videoId: string } | null;
};
type ScanResult = { status: "no_workspace" } | { status: "workspace_unavailable"; reason: string } | { status: "ok"; packages: PackageRow[] };

const STATE_STYLE: Record<PackageRow["state"], string> = {
  not_ready: "bg-red-950/50 text-red-300",
  ready: "bg-emerald-950/50 text-emerald-300",
  uploaded_private: "bg-zinc-800 text-zinc-300",
  scheduled: "bg-indigo-950/60 text-indigo-200",
  published: "bg-zinc-800 text-zinc-400",
  uploaded_unknown: "bg-amber-950/40 text-amber-200",
};

/** The planned day at the channel's UTC publish time, with the owner's own time for that day. */
function PlannedTime({ date, publishTimeUtc }: { date: string | null; publishTimeUtc: string | null }) {
  const { t } = useUiText();
  const on = date ? new Date(`${date}T12:00:00Z`) : undefined;
  const hint = useUtcLocalHint(publishTimeUtc ?? "", { on });
  if (!date) return <span className="text-zinc-500">{t("publishingPackages.noDate")}</span>;
  return (
    <span>
      {publishTimeUtc ? t("publishingPackages.planned", { date: formatDisplayDateUtc(`${date}T00:00:00Z`), time: publishTimeUtc }) : formatDisplayDateUtc(`${date}T00:00:00Z`)}
      {hint && (
        <span className="ml-1 text-zinc-500" title={hint.title}>
          {hint.text}
        </span>
      )}
    </span>
  );
}

/**
 * BL-182 stage 2 (FO-REQ-0023 §4 B1): the channel's release packages under `04 Videos/`, each with its state -- not ready (and
 * why) / ready / uploaded private / scheduled / published -- in the order they are planned. Read-only for now: the upload and
 * its approval screen come next. The planned time is the package's day at the channel's publish time (UTC, owner msgs
 * 2725/2727). Loaded when the tab is shown and on «Обновить»; reading the folder makes no YouTube call.
 */
export function PublishingPackages({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const { t, formatNumber } = useUiText();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [publishTimeUtc, setPublishTimeUtc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const base = `/api/channels/${encodeURIComponent(channelId)}`;
      const [packagesRes, settingsRes] = await Promise.all([fetch(`${base}/publishing/packages`), fetch(`${base}/publishing-settings`)]);
      const data = await packagesRes.json();
      if (!packagesRes.ok) throw new Error(errorText(t, data, t("publishingPackages.loadFailed")));
      setResult(data);
      if (settingsRes.ok) setPublishTimeUtc(((await settingsRes.json()) as { settings?: { publishTimeUtc?: string } }).settings?.publishTimeUtc ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingPackages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [channelId, t]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  if (!channelId) return null;
  const packages = result?.status === "ok" ? result.packages : [];
  const counts = {
    total: packages.length,
    ready: packages.filter((p) => p.state === "ready").length,
    notReady: packages.filter((p) => p.state === "not_ready").length,
    uploaded: packages.filter((p) => p.youtube !== null).length,
  };
  const problemText = (problem: Problem) => t(`publishingPackages.problem.${problem.code}` as UiTextKey, problem.params ?? {});
  const duration = (seconds: number) => t("duration.hoursMinutes", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-zinc-100">{t("publishingPackages.title")}</h3>
          <p className="mt-1 max-w-3xl text-xs text-zinc-400">{t("publishingPackages.intro")}</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50">
          {t("publishingPackages.refresh")}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {!result && !error && <LoadingIndicator className="text-xs text-zinc-400" />}
      {result?.status === "no_workspace" && <p className="text-xs text-amber-200">{t("publishingPackages.noWorkspace")}</p>}
      {result?.status === "workspace_unavailable" && <p className="text-xs text-amber-200">{t("publishingPackages.workspaceUnavailable", { reason: result.reason })}</p>}
      {result?.status === "ok" && packages.length === 0 && <p className="text-xs text-zinc-400">{t("publishingPackages.empty")}</p>}
      {packages.length > 0 && (
        <>
          <p className="text-xs text-zinc-400">{t("publishingPackages.summary", counts)}</p>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {packages.map((p) => (
              <li key={p.manifestPath} className="flex gap-3 px-3 py-2">
                <div className="h-[54px] w-24 shrink-0 overflow-hidden rounded bg-zinc-800">
                  {p.thumbnailPath && (
                    // eslint-disable-next-line @next/next/no-img-element -- a local, session-checked image route, not a static asset
                    <img
                      src={`/api/channels/${encodeURIComponent(channelId)}/publishing/packages/thumbnail?path=${encodeURIComponent(p.thumbnailPath)}`}
                      alt={t("publishingPackages.thumbnailAlt", { video: p.video ?? "" })}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{p.video ?? p.manifestPath}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_STYLE[p.state]}`}>{t(`publishingPackages.state.${p.state}` as UiTextKey)}</span>
                    {p.youtube && (
                      <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(p.youtube.videoId)}`} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 underline hover:text-zinc-200">
                        {t("publishingPackages.openOnYoutube")}
                      </a>
                    )}
                  </div>
                  {p.title && <p className="truncate text-zinc-100">{p.title}</p>}
                  <p className="text-xs text-zinc-400">
                    <PlannedTime date={p.plannedPublishDate} publishTimeUtc={publishTimeUtc} />
                    {p.durationSeconds !== null && <span> · {duration(p.durationSeconds)}</span>}
                    {p.sizeBytes !== null && <span> · {formatBytes(t, formatNumber, p.sizeBytes)}</span>}
                  </p>
                  {p.problems.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-300">
                      {p.problems.map((problem, i) => (
                        <li key={i}>{problemText(problem)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
