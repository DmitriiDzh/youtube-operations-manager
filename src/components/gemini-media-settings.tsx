"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §2.8): Settings → Gemini. The owner's side of the module the Factory Operator
// drives over MCP: the API key (checked with Google, stored encrypted, shown only by its last 4 characters), the switch that lets
// the operator spend, the limits, this computer's spend and the newest jobs. Text inputs (not native number widgets), so the
// stored digits read the same in every locale.

type KeyView = { configured: boolean; keyHint: string | null; status: "ok" | "payment_required" | null; verifiedAt: string | null };
type Settings = { enabled: boolean; maxUsdPerJob: number; maxUsdPerDay: number; maxUsdPerMonth: number; maxActiveJobs: number };
type Spend = { todayUsd: number; monthUsd: number; activeUsd: number; activeJobs: number };
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
type Overview = { key: KeyView; settings: Settings; spend: Spend; gatewayEnabled: boolean; pricesAsOf: string; jobs: Job[] };

const LIMIT_FIELDS = ["maxUsdPerJob", "maxUsdPerDay", "maxUsdPerMonth", "maxActiveJobs"] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

const inputClass = "w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** A positive amount in USD (up to 4 decimals), or a whole count for active jobs; `null` when not valid. */
function parseLimit(field: LimitField, text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (field === "maxActiveJobs") return /^\d{1,3}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 100 ? Number(trimmed) : null;
  if (!/^\d{1,5}(\.\d{1,4})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= 10_000 ? value : null;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function GeminiMediaSettings() {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // State updates happen in the promise callbacks (the shape the react-hooks/set-state-in-effect rule allows).
  const load = useCallback(
    () =>
      requestJson<Overview>("/api/gemini-media", undefined, t("settings.loadFailed"), t).then(
        (data) => {
          setOverview(data);
          setLoadError(null);
        },
        (error: unknown) => setLoadError(error instanceof Error ? error.message : t("settings.loadFailed"))
      ),
    [t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!overview) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
            <button onClick={() => void load()} className={buttonClass}>
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <div className="flex items-center gap-3 rounded-xl border border-red-900 bg-zinc-900 p-3">
          <p className="text-sm text-red-400">{loadError}</p>
          <button onClick={() => void load()} className={buttonClass}>
            {t("common.retry")}
          </button>
        </div>
      )}
      <KeyCard view={overview.key} onChanged={load} />
      <GenerationCard overview={overview} onChanged={load} />
      <JobsCard jobs={overview.jobs} onRefresh={load} />
    </div>
  );
}

function KeyCard({ view, onChanged }: { view: KeyView; onChanged: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(!view.configured);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!view.configured) setEditing(true);
  }, [view.configured]);

  async function run(action: () => Promise<void>, done: string, fallback: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      async () => {
        await requestJson("/api/gemini-media/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey }) }, t("gemini.key.saveFailed"), t);
        setApiKey("");
        setEditing(false);
      },
      t("gemini.key.saved"),
      t("gemini.key.saveFailed")
    );
  const check = () => run(async () => void (await requestJson("/api/gemini-media/key/test", { method: "POST" }, t("gemini.key.checkFailed"), t)), t("gemini.key.checked"), t("gemini.key.checkFailed"));
  const remove = () => {
    setConfirmRemove(false);
    void run(async () => void (await requestJson("/api/gemini-media/key", { method: "DELETE" }, t("gemini.key.removeFailed"), t)), t("gemini.key.removed"), t("gemini.key.removeFailed"));
  };

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("gemini.key.title")}
        <InfoTooltip>{t("gemini.key.info")}</InfoTooltip>
      </h3>
      {view.configured && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            {t("gemini.key.stored")} <span className="font-mono text-zinc-100">…{view.keyHint}</span>
            {view.verifiedAt && <span className="text-zinc-500"> · {t("gemini.key.verifiedAt", { at: new Date(view.verifiedAt).toLocaleString(t.language) })}</span>}
          </p>
          {view.status === "payment_required" && <p className="text-xs text-amber-400">{t("gemini.key.paymentRequired")}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void check()} disabled={busy} className={buttonClass}>
              {t("gemini.key.check")}
            </button>
            <button onClick={() => setEditing(true)} disabled={busy} className={buttonClass}>
              {t("gemini.key.replace")}
            </button>
            <button onClick={() => setConfirmRemove(true)} disabled={busy} className={`${buttonClass} text-red-300`}>
              {t("gemini.key.remove")}
            </button>
          </div>
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Not type="password": Chrome ignores autocomplete="off" there and filled a saved login password into this field (seen
                live 2026-10-11), which "Check and save" would have sent to Google. A text field whose characters are hidden is never
                offered saved passwords; the password-manager extensions are told to skip it too. */}
            <input
              type="text"
              name="gemini-api-key"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
              placeholder={t("gemini.key.placeholder")}
              aria-label={t("gemini.key.inputAria")}
              className="w-80 max-w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-100 [-webkit-text-security:disc] disabled:opacity-50"
            />
            <button onClick={() => void save()} disabled={busy || apiKey.trim().length < 20} className={primaryClass}>
              {t("gemini.key.save")}
            </button>
            {view.configured && (
              <button onClick={() => setEditing(false)} disabled={busy} className={buttonClass}>
                {t("common.cancel")}
              </button>
            )}
          </div>
          <p className="text-xs text-zinc-500">{t("gemini.key.hint")}</p>
        </div>
      )}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmRemove && (
        <ConfirmDialog
          title={t("gemini.key.removeTitle")}
          description={t("gemini.key.removeDescription")}
          confirmLabel={t("gemini.key.remove")}
          confirmVariant="danger"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}

function GenerationCard({ overview, onChanged }: { overview: Overview; onChanged: () => Promise<void> }) {
  const t = useT();
  const { settings, spend } = overview;
  const [drafts, setDrafts] = useState<Record<LimitField, string>>(() => Object.fromEntries(LIMIT_FIELDS.map((f) => [f, String(settings[f])])) as Record<LimitField, string>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Reset the fields only when the SAVED values change (a reload builds a new object each time and would wipe unsaved edits).
  const savedKey = LIMIT_FIELDS.map((f) => settings[f]).join("|");
  useEffect(() => {
    setDrafts(Object.fromEntries(savedKey.split("|").map((value, i) => [LIMIT_FIELDS[i], value])) as Record<LimitField, string>);
  }, [savedKey]);

  const parsed = Object.fromEntries(LIMIT_FIELDS.map((f) => [f, parseLimit(f, drafts[f])])) as Record<LimitField, number | null>;
  const valid = LIMIT_FIELDS.every((f) => parsed[f] !== null);
  const dirty = valid && LIMIT_FIELDS.some((f) => parsed[f] !== settings[f]);

  async function put(patch: Partial<Settings>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/gemini-media/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }, t("settings.saveFailed"), t);
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const labels: Record<LimitField, string> = {
    maxUsdPerJob: t("gemini.limits.perJob"),
    maxUsdPerDay: t("gemini.limits.perDay"),
    maxUsdPerMonth: t("gemini.limits.perMonth"),
    maxActiveJobs: t("gemini.limits.activeJobs"),
  };

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("gemini.generation.title")}
        <InfoTooltip>{t("gemini.generation.info")}</InfoTooltip>
      </h3>
      <div className="flex items-center gap-3">
        <ToggleSwitch checked={settings.enabled} onChange={(next) => void put({ enabled: next }, next ? t("gemini.generation.turnedOn") : t("gemini.generation.turnedOff"))} disabled={busy} label={t("gemini.generation.switch")} />
        <span className="text-sm text-zinc-200">{t("gemini.generation.switch")}</span>
      </div>
      {settings.enabled && !overview.key.configured && <p className="text-xs text-amber-400">{t("gemini.generation.noKey")}</p>}
      {!overview.gatewayEnabled && <p className="text-xs text-amber-400">{t("gemini.generation.gatewayOff")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {LIMIT_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="text"
              inputMode="decimal"
              value={drafts[field]}
              onChange={(e) => setDrafts((current) => ({ ...current, [field]: e.target.value }))}
              disabled={busy}
              aria-label={labels[field]}
              className={`${inputClass} ${parsed[field] === null ? "border-red-700" : ""}`}
            />
            {labels[field]}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void put(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, parsed[f]])) as Partial<Settings>, t("common.saved"))}
          disabled={busy || !dirty}
          className={primaryClass}
        >
          {t("common.save")}
        </button>
        {!valid && <span className="text-xs text-red-400">{t("gemini.limits.invalid")}</span>}
      </div>
      <p className="text-sm text-zinc-300">
        {t("gemini.spend.line", { today: usd(spend.todayUsd), month: usd(spend.monthUsd) })}
        {spend.activeJobs > 0 && <span className="text-zinc-500"> · {t("gemini.spend.active", { count: spend.activeJobs, amount: usd(spend.activeUsd) })}</span>}
      </p>
      <p className="text-xs text-zinc-500">{t("gemini.spend.note", { date: overview.pricesAsOf })}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
    </div>
  );
}

function JobsCard({ jobs, onRefresh }: { jobs: Job[]; onRefresh: () => Promise<void> }) {
  const t = useT();
  const statusLabel: Record<Job["status"], string> = {
    queued: t("gemini.jobs.status.queued"),
    submitting: t("gemini.jobs.status.submitting"),
    running: t("gemini.jobs.status.running"),
    done: t("gemini.jobs.status.done"),
    failed: t("gemini.jobs.status.failed"),
  };
  const statusTone: Record<Job["status"], string> = { queued: "text-zinc-300", submitting: "text-sky-300", running: "text-sky-300", done: "text-emerald-400", failed: "text-red-400" };
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-medium text-zinc-100">{t("gemini.jobs.title")}</h3>
        <button onClick={() => void onRefresh()} className={buttonClass}>
          {t("gemini.jobs.refresh")}
        </button>
      </div>
      {jobs.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("gemini.jobs.none")}</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {jobs.map((job) => (
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
    </div>
  );
}
