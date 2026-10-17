"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { usd } from "./gemini-media-settings";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867): Servers → Sessions shows Gemini next to RunPod -- this computer's recent
// Gemini jobs with what each cost (or its estimate, marked ≈), and the spend today and this month against the limits, for every
// computer that uses the same Gemini key (ADR 0039). No balance: Google offers none to read. The card reads only
// `/api/gemini-media`; when that fails (the module off, broken or unreachable) it says so and the rest of Servers is unaffected
// (it is also wrapped in its own FeatureErrorBoundary, AGENTS.md §M).

type Job = {
  jobId: string;
  kind: "image" | "video";
  model: string;
  status: "queued" | "submitting" | "running" | "done" | "failed";
  estimateUsd: number;
  costUsd: number | null;
  outputs: Array<{ path: string }>;
  error: string | null;
  errorCode: string | null;
  createdAt: string;
};
type PeerSpend = { deviceId: string; hostname: string | null; todayUsd: number; monthUsd: number; updatedAt: string; stale: boolean };
type Spend = { todayUsd: number; monthUsd: number; activeUsd: number; activeJobs: number; account?: { todayUsd: number; monthUsd: number; keyKnown: boolean; otherComputers: PeerSpend[] } };
type Overview = { key: { configured: boolean }; settings: { enabled: boolean; maxUsdPerDay: number; maxUsdPerMonth: number }; spend: Spend; jobs: Job[] };

/** What the Servers header shows for Gemini: today's spend on the key against the daily limit. */
export type GeminiTodayFigure = { todayUsd: number; maxUsdPerDay: number };

/** The key's spend with this computer's part (pure, for the card and its test): `others` is what the other computers reported. */
export function geminiSpendSplit(spend: Spend): { today: number; month: number; ownToday: number; ownMonth: number; othersToday: number; othersMonth: number } {
  const today = spend.account?.todayUsd ?? spend.todayUsd;
  const month = spend.account?.monthUsd ?? spend.monthUsd;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return { today, month, ownToday: spend.todayUsd, ownMonth: spend.monthUsd, othersToday: round(today - spend.todayUsd), othersMonth: round(month - spend.monthUsd) };
}

const POLL_MS = 30_000;
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

export function GeminiServersCard({ onToday }: { onToday?: (figure: GeminiTodayFigure | null) => void }) {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // State changes only in the promise callbacks (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      fetch("/api/gemini-media")
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as Overview | null;
          if (!res.ok || !body) throw new Error(errorText(t, body, t("settings.loadFailed"), { showErrorField: false }));
          setOverview(body);
          setError(null);
          const split = geminiSpendSplit(body.spend);
          onToday?.({ todayUsd: split.today, maxUsdPerDay: body.settings.maxUsdPerDay });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : t("settings.loadFailed"));
          onToday?.(null);
        }),
    [t, onToday]
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const statusLabel: Record<Job["status"], string> = {
    queued: t("gemini.jobs.status.queued"),
    submitting: t("gemini.jobs.status.submitting"),
    running: t("gemini.jobs.status.running"),
    done: t("gemini.jobs.status.done"),
    failed: t("gemini.jobs.status.failed"),
  };
  const statusTone: Record<Job["status"], string> = { queued: "text-zinc-300", submitting: "text-sky-300", running: "text-sky-300", done: "text-emerald-400", failed: "text-red-400" };

  const split = overview ? geminiSpendSplit(overview.spend) : null;
  const peers = overview?.spend.account?.otherComputers ?? [];
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("gemini.servers.title")}
          <InfoTooltip>{t("gemini.servers.info")}</InfoTooltip>
        </h3>
        <button type="button" onClick={() => void load()} className={buttonClass}>
          {t("gemini.jobs.refresh")}
        </button>
      </div>
      {error && <p className="text-sm text-amber-400">{t("gemini.servers.unavailable", { error })}</p>}
      {!overview && !error && <LoadingIndicator className="text-sm text-zinc-400" />}
      {overview && split && (
        <>
          <div className="space-y-1 text-sm text-zinc-200">
            <p>
              {t("gemini.servers.today", { spent: usd(split.today), limit: usd(overview.settings.maxUsdPerDay) })}
              {split.othersToday > 0 && <span className="text-zinc-500"> · {t("gemini.servers.split", { own: usd(split.ownToday), others: usd(split.othersToday) })}</span>}
            </p>
            <p>
              {t("gemini.servers.month", { spent: usd(split.month), limit: usd(overview.settings.maxUsdPerMonth) })}
              {split.othersMonth > 0 && <span className="text-zinc-500"> · {t("gemini.servers.split", { own: usd(split.ownMonth), others: usd(split.othersMonth) })}</span>}
            </p>
            {overview.spend.activeJobs > 0 && <p className="text-xs text-zinc-500">{t("gemini.spend.active", { count: overview.spend.activeJobs, amount: usd(overview.spend.activeUsd) })}</p>}
          </div>
          {peers.length > 0 && (
            <ul className="space-y-0.5 text-xs text-zinc-400">
              {peers.map((p) => (
                <li key={p.deviceId}>
                  {t(p.stale ? "gemini.servers.otherComputerStale" : "gemini.servers.otherComputer", { host: p.hostname ?? t("gemini.servers.unknownHost"), today: usd(p.todayUsd), month: usd(p.monthUsd) })}
                </li>
              ))}
            </ul>
          )}
          {overview.spend.account && !overview.spend.account.keyKnown && <p className="text-xs text-zinc-500">{t("gemini.servers.noKey")}</p>}
          {!overview.settings.enabled && <p className="text-xs text-zinc-500">{t("gemini.servers.off")}</p>}
          <div className="space-y-1 border-t border-zinc-800 pt-3">
            <p className="text-sm font-medium text-zinc-200">{t("gemini.jobs.title")}</p>
            {overview.jobs.length === 0 ? (
              <p className="text-sm text-zinc-500">{t("gemini.jobs.none")}</p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {overview.jobs.map((job) => (
                  <li key={job.jobId} className="space-y-0.5 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-zinc-500">{new Date(job.createdAt).toLocaleString(t.language)}</span>
                      <span className="text-zinc-200">{job.model}</span>
                      <span className="text-zinc-500">{job.kind === "image" ? t("gemini.jobs.image") : t("gemini.jobs.video")}</span>
                      <span className={statusTone[job.status]}>{statusLabel[job.status]}</span>
                      <span className="text-zinc-400">{job.costUsd !== null ? usd(job.costUsd) : t("gemini.jobs.estimate", { amount: usd(job.estimateUsd) })}</span>
                    </div>
                    {job.outputs.length > 0 && <p className="break-all font-mono text-xs text-zinc-400">{t("gemini.jobs.output", { path: job.outputs[0].path })}</p>}
                    {job.status === "failed" && job.error && (
                      <p className="text-xs text-red-400">
                        {job.errorCode ? `${job.errorCode}: ` : ""}
                        {job.error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {overview.jobs.some((job) => job.costUsd === null) && <p className="text-xs text-zinc-500">{t("gemini.servers.estimateNote")}</p>}
          </div>
        </>
      )}
    </div>
  );
}
