"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { CLOUD_CREDENTIALS_IMPORTED_EVENT } from "./cloud-credentials-transfer";
import { MaskedSecretInput } from "./masked-secret-input";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §2.8): Settings → Cloud APIs. The owner's side of the module the Factory Operator
// drives over MCP: the API key (checked with Google, stored encrypted, shown only by its last 4 characters), the switch that lets
// the operator spend, the limits and the spend. Text inputs (not native number widgets), so the stored digits read the same in
// every locale. BL-193: the jobs moved to Servers (their own Gemini card); the limits are shared by every computer on the key and
// the spend shown is the key's (ADR 0039).

type KeyView = { configured: boolean; keyHint: string | null; status: "ok" | "payment_required" | null; verifiedAt: string | null };
type Settings = { enabled: boolean; maxUsdPerJob: number; maxUsdPerDay: number; maxUsdPerMonth: number; maxActiveJobs: number };
type Spend = { todayUsd: number; monthUsd: number; activeUsd: number; activeJobs: number; account?: { todayUsd: number; monthUsd: number; keyKnown: boolean; otherComputers: unknown[] } };
type Overview = { key: KeyView; settings: Settings; spend: Spend; gatewayEnabled: boolean; pricesAsOf: string };

const LIMIT_FIELDS = ["maxUsdPerJob", "maxUsdPerDay", "maxUsdPerMonth", "maxActiveJobs"] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

const inputClass = "w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

/** A Gemini amount in USD: 4 decimals below $1 (an image costs cents), trailing zeros dropped. Shared with the Servers card. */
export function usd(value: number): string {
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
    // BL-193: a key imported from the cloud-keys file shows here at once.
    const onImported = () => void load();
    window.addEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, onImported);
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
            {/* MaskedSecretInput, never a password field (Chrome autofilled a saved login password here, 2026-10-11). */}
            <MaskedSecretInput
              name="gemini-api-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
              placeholder={t("gemini.key.placeholder")}
              aria-label={t("gemini.key.inputAria")}
              className="w-80 max-w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-100 disabled:opacity-50"
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
      <p className="text-xs text-zinc-500">{t("gemini.limits.shared")}</p>
      <p className="text-sm text-zinc-300">
        {t("gemini.spend.line", { today: usd(spend.account?.todayUsd ?? spend.todayUsd), month: usd(spend.account?.monthUsd ?? spend.monthUsd) })}
        {spend.activeJobs > 0 && <span className="text-zinc-500"> · {t("gemini.spend.active", { count: spend.activeJobs, amount: usd(spend.activeUsd) })}</span>}
      </p>
      <p className="text-xs text-zinc-500">{t("gemini.spend.note", { date: overview.pricesAsOf })}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
    </div>
  );
}
