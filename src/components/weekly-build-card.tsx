"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import {
  WEEKLY_BUILD_DAYS_DEFAULT,
  WEEKLY_BUILD_DAYS_MAX,
  WEEKLY_BUILD_DAYS_MIN,
  type WeeklyBuildDryRun,
  type WeeklyBuildSettings,
  type WeeklyBuildSlot,
  type WeeklyBuildView,
} from "@/lib/weekly-build/contracts";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { useT } from "./ui-text-provider";

// BL-231 (FO-REQ-0046; WEEKLY_BUILD_BUTTON_PLAN.md §5): Content → «План недели» → «Сборка недели». The owner's questions, in order:
// can the factory build here (or why not), what will «Собрать неделю» do (the dry run, confirmed in our own dialog), how far is it
// (the slot table, a failed slot's problems), what waits for me or the agent («Нужна упаковка», «Разбудить агента»), and how do I
// stop it. Refreshes every 30 s while visible and a job runs; otherwise on open and «Обновить».

const REFRESH_MS = 30_000;

const SLOT_STYLES: Record<string, string> = {
  planned: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  building: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  built: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  packaged: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  failed: "bg-red-500/15 text-red-300 ring-red-500/30",
  skipped: "bg-zinc-800 text-zinc-500 ring-zinc-700",
};
const KNOWN_SLOT = new Set(Object.keys(SLOT_STYLES));
const KNOWN_STEP = new Set(["draft", "run", "package_request", "wait"]);

type ApiError = { error?: string; message?: string };

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function WeeklyBuildCard({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const [view, setView] = useState<WeeklyBuildView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = useState(WEEKLY_BUILD_DAYS_DEFAULT);
  const [busy, setBusy] = useState<"check" | "start" | "stop" | "wake" | "python" | "refresh" | null>(null);
  const [dryRun, setDryRun] = useState<WeeklyBuildDryRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [python, setPython] = useState("");

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/weekly-build` : null;

  const errorText = useCallback(
    async (res: Response) => {
      const body = (await res.json().catch(() => ({}))) as ApiError;
      if (body.error === "weekly_build_job_running") return t("weeklyBuild.error.running");
      return body.message ?? `HTTP ${res.status}`;
    },
    [t]
  );

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const res = await fetch(base, { cache: "no-store" });
      if (!res.ok) throw new Error(await errorText(res));
      setView((await res.json()) as WeeklyBuildView);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [base, errorText]);

  useEffect(() => {
    setView(null);
    setNotice(null);
    setActionError(null);
  }, [channelId]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  useEffect(() => {
    if (!visible || !view?.running) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, view?.running, load]);

  useEffect(() => {
    if (!visible) return;
    void fetch("/api/weekly-build/settings", { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<WeeklyBuildSettings>) : null))
      .then((settings) => settings && setPython(settings.pythonPath ?? ""))
      .catch(() => undefined);
  }, [visible]);

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    setActionError(null);
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      setActionError(await errorText(res));
      return null;
    }
    return (await res.json()) as T;
  }

  async function askBuild() {
    setBusy("check");
    setNotice(null);
    try {
      const result = await post<WeeklyBuildDryRun>("/dry-run", { days });
      if (result) setDryRun(result);
    } finally {
      setBusy(null);
    }
  }

  async function start(wake: boolean) {
    setBusy(wake ? "wake" : "start");
    try {
      const result = await post<{ jobId: string }>("/start", { days, wake });
      if (result) setNotice(wake ? t("weeklyBuild.packaging.woken") : t("weeklyBuild.started", { jobId: result.jobId }));
      setDryRun(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stop");
    try {
      if (await post("/stop", {})) setNotice(t("weeklyBuild.stopped"));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function savePython() {
    setBusy("python");
    setActionError(null);
    try {
      const res = await fetch("/api/weekly-build/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pythonPath: python.trim() || null }) });
      if (!res.ok) setActionError(await errorText(res));
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!channelId) return null;

  const readiness = view?.readiness;
  const status = view?.status ?? null;
  const job = status?.job ?? null;
  const built = status?.slots.filter((s) => s.status === "built") ?? [];
  const request = status?.packageRequest ?? null;
  const ready = readiness?.ready === true;
  const showPython = !readiness || readiness.ready || readiness.code === "python_missing" || readiness.code === "launcher_check_failed";

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold text-zinc-100">{t("weeklyBuild.title")}</h2>
          <p className="max-w-3xl text-sm text-zinc-400">{t("weeklyBuild.help")}</p>
          {status?.line && <p className="text-sm text-zinc-200">{status.line}</p>}
        </div>
        <ActionButton busy={busy === "refresh"} disabled={busy !== null} onClick={() => void refresh()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
          {t("weeklyBuild.refresh")}
        </ActionButton>
      </div>

      {!view && !loadError && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-500">{t("weeklyBuild.loading")}</p>
          <SkeletonLines lines={3} />
        </div>
      )}
      {loadError && <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{loadError}</p>}

      {readiness && !readiness.ready && (
        <div className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          <p>{t(`weeklyBuild.block.${readiness.code}` as UiTextKey, { bundle: readiness.bundle ?? "?" })}</p>
          {readiness.code === "launcher_check_failed" && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-amber-100/80">{readiness.message}</pre>}
        </div>
      )}

      {view?.statusError && <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{t("weeklyBuild.statusUnreadable", { message: view.statusError })}</p>}

      {ready && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-zinc-400">
            {t("weeklyBuild.days")}
            <input
              type="text"
              inputMode="numeric"
              value={String(days)}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ""));
                if (Number.isInteger(n)) setDays(Math.min(WEEKLY_BUILD_DAYS_MAX, Math.max(WEEKLY_BUILD_DAYS_MIN, n || WEEKLY_BUILD_DAYS_MIN)));
              }}
              className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            />
          </label>
          <ActionButton
            busy={busy === "check"}
            busyLabel={t("weeklyBuild.checking")}
            disabled={busy !== null || view?.running === true}
            onClick={() => void askBuild()}
            className="rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("weeklyBuild.build")}
          </ActionButton>
          {view?.running && (
            <ActionButton busy={busy === "stop"} busyLabel={t("weeklyBuild.stopping")} disabled={busy !== null || status?.stopped === true} onClick={() => void stop()} className="rounded-md border border-red-800 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950/50 disabled:opacity-40">
              {t("weeklyBuild.stop")}
            </ActionButton>
          )}
          {readiness?.ready && <span className="text-xs text-zinc-500">{t("weeklyBuild.bundle", { bundle: readiness.bundle })}</span>}
        </div>
      )}

      {notice && <p className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">{notice}</p>}
      {actionError && <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">{actionError}</p>}

      {job && (
        <p className="text-sm text-zinc-300">
          {view?.running
            ? t("weeklyBuild.job.running", { at: when(job.startedAt), jobId: job.jobId })
            : job.finishedAt
              ? t("weeklyBuild.job.ended", { state: job.state, at: when(job.finishedAt) })
              : t("weeklyBuild.job.endedNoTime", { state: job.state })}
          {status?.stopped && view?.running ? ` ${t("weeklyBuild.stopped")}` : ""}
        </p>
      )}

      {ready && status && !status.plan && <p className="text-sm text-zinc-400">{t("weeklyBuild.noPlan")}</p>}

      {built.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-900/60 bg-amber-950/30 px-4 py-3">
          <div className="space-y-1 text-sm">
            <p className="font-medium text-amber-200">{t("weeklyBuild.packaging.title", { count: built.length })}</p>
            <p className="text-zinc-300">{t("weeklyBuild.packaging.text")}</p>
            {request?.pending && <p className="text-zinc-400">{t("weeklyBuild.packaging.requested", { at: when(request.writtenAt) })}</p>}
          </div>
          <ActionButton busy={busy === "wake"} busyLabel={t("weeklyBuild.packaging.waking")} disabled={busy !== null || view?.running === true} onClick={() => void start(true)} className="rounded-md border border-amber-700 px-4 py-2 text-sm font-medium text-amber-200 hover:bg-amber-950/60 disabled:opacity-40">
            {t("weeklyBuild.packaging.wake")}
          </ActionButton>
        </div>
      )}

      {status && status.slots.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="bg-zinc-950/60 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">{t("weeklyBuild.col.date")}</th>
                <th className="px-3 py-2 font-medium">{t("weeklyBuild.col.status")}</th>
                <th className="px-3 py-2 font-medium">{t("weeklyBuild.col.video")}</th>
                <th className="px-3 py-2 font-medium">{t("weeklyBuild.col.length")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {status.slots.map((slot) => (
                <SlotRow key={slot.slotId} slot={slot} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showPython && (
        <details className="rounded-lg border border-zinc-800 px-3 py-2" open={readiness?.ready === false && readiness.code === "python_missing"}>
          <summary className="cursor-pointer select-none text-sm text-zinc-400 hover:text-zinc-200">
            {t("weeklyBuild.python.label")}
            {readiness?.ready && <span className="ml-2 text-xs text-zinc-500">{t("weeklyBuild.python.using", { python: readiness.python })}</span>}
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="text" value={python} placeholder={t("weeklyBuild.python.placeholder")} onChange={(e) => setPython(e.target.value)} className="min-w-[16rem] flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100" />
            <ActionButton busy={busy === "python"} busyLabel={t("weeklyBuild.python.saving")} disabled={busy !== null} onClick={() => void savePython()} className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weeklyBuild.python.save")}
            </ActionButton>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{t("weeklyBuild.python.help")}</p>
        </details>
      )}

      {dryRun && (
        <ConfirmDialog
          title={t("weeklyBuild.confirm.title")}
          description={t("weeklyBuild.confirm.description", { days: dryRun.days })}
          confirmLabel={t("weeklyBuild.confirm.start")}
          confirmBusyLabel={busy === "start" ? t("weeklyBuild.confirm.starting") : null}
          confirmDisabled={dryRun.steps.length === 0 || busy !== null}
          onCancel={() => setDryRun(null)}
          onConfirm={() => void start(false)}
        >
          <div className="space-y-2 text-sm">
            <p className="text-zinc-400">{dryRun.plan ? t("weeklyBuild.confirm.plan", { plan: dryRun.plan }) : t("weeklyBuild.confirm.newPlan")}</p>
            {dryRun.steps.length === 0 ? (
              <p className="text-zinc-300">{t("weeklyBuild.confirm.noSteps")}</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-zinc-200">
                {dryRun.steps.map((step, i) => (
                  <li key={i}>
                    {KNOWN_STEP.has(step.step) ? t(`weeklyBuild.step.${step.step}` as UiTextKey) : step.step}
                    <span className="block text-xs text-zinc-500">{step.text}</span>
                    {step.slots.length > 0 && <span className="block text-xs text-zinc-500">{t("weeklyBuild.step.slots", { slots: step.slots.join(", ") })}</span>}
                  </li>
                ))}
              </ol>
            )}
            {dryRun.stopped && <p className="text-amber-300">{t("weeklyBuild.confirm.clearsStop")}</p>}
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

function SlotRow({ slot }: { slot: WeeklyBuildSlot }) {
  const t = useT();
  const known = KNOWN_SLOT.has(slot.status);
  return (
    <tr className="align-top">
      <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{slot.date}</td>
      <td className="px-3 py-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${SLOT_STYLES[slot.status] ?? SLOT_STYLES.planned}`}>{known ? t(`weeklyBuild.slot.${slot.status}` as UiTextKey) : slot.status}</span>
        {slot.status === "failed" && (
          <div className="mt-1 space-y-0.5 text-xs text-red-300">
            {slot.problems.map((problem, i) => (
              <p key={i}>{problem}</p>
            ))}
            {slot.retryable && <p className="text-zinc-500">{t("weeklyBuild.slot.retryable")}</p>}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-zinc-300">
        {slot.video ?? "—"}
        {slot.folder && <span className="block text-xs text-zinc-500">{slot.folder}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-zinc-300">{slot.hours !== null ? t("weeklyBuild.hours", { hours: slot.hours }) : "—"}</td>
    </tr>
  );
}
