"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-236 (FO-REQ-0050, ADR 0057): Settings → Cloud APIs → ElevenLabs. The owner's side of the speech module the Operator (and a
// channel's worker) drive over MCP: the key (checked with ElevenLabs, stored encrypted, shown only by its last 4 characters), the
// switch for THIS computer (off by default), the limits in characters, the output format and the usage. Text inputs, not native
// number widgets (the digits read the same in every locale).

type Limits = { maxCharsPerJob: number; maxCharsPerDay: number; maxCharsPerMonth: number; maxActiveJobs: number };
type Status = {
  enabled: boolean;
  keyConfigured: boolean;
  keyHint: string | null;
  keyStatus: "ok" | "payment_required" | null;
  gatewayEnabled: boolean;
  limits: Limits;
  outputFormat: string;
  outputFormats: string[];
  usage: { todayChars: number; monthChars: number; activeJobs: number; monthUsd: number };
  subscription?: { tier?: string | null; characterCount?: number | null; characterLimit?: number | null; errorCode?: string } | null;
};

const LIMIT_FIELDS = ["maxCharsPerJob", "maxCharsPerDay", "maxCharsPerMonth", "maxActiveJobs"] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

const inputClass = "w-28 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

/** A whole positive number of characters (or takes at once, 1-50); `null` when not valid. */
export function parseCharLimit(field: LimitField, text: string): number | null {
  const trimmed = text.trim().replace(/[\s ]/g, "");
  if (!/^\d{1,8}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (field === "maxActiveJobs") return value >= 1 && value <= 50 ? value : null;
  return value >= 1 && value <= 10_000_000 ? value : null;
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function ElevenlabsSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    (subscription = false) =>
      requestJson<Status>(`/api/elevenlabs-speech${subscription ? "?subscription=1" : ""}`, undefined, t("settings.loadFailed"), t).then(
        (data) => {
          setStatus(data);
          setLoadError(null);
        },
        (error: unknown) => setLoadError(error instanceof Error ? error.message : t("settings.loadFailed"))
      ),
    [t]
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) {
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
      <KeyCard status={status} onChanged={() => load()} />
      <SpeechCard status={status} onChanged={() => load()} onSubscription={() => load(true)} />
    </div>
  );
}

function KeyCard({ status, onChanged }: { status: Status; onChanged: () => Promise<void> }) {
  const t = useT();
  const [editing, setEditing] = useState(!status.keyConfigured);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!status.keyConfigured) setEditing(true);
  }, [status.keyConfigured]);

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
        await requestJson("/api/elevenlabs-speech/key", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey }) }, t("speech.el.key.saveFailed"), t);
        setApiKey("");
        setEditing(false);
      },
      t("speech.el.key.saved"),
      t("speech.el.key.saveFailed")
    );
  const check = () => run(async () => void (await requestJson("/api/elevenlabs-speech/key/test", { method: "POST" }, t("speech.el.key.checkFailed"), t)), t("speech.el.key.checked"), t("speech.el.key.checkFailed"));
  const remove = () => {
    setConfirmRemove(false);
    void run(async () => void (await requestJson("/api/elevenlabs-speech/key", { method: "DELETE" }, t("speech.el.key.removeFailed"), t)), t("speech.el.key.removed"), t("speech.el.key.removeFailed"));
  };

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("speech.el.key.title")}
        <InfoTooltip>{t("speech.el.info")}</InfoTooltip>
      </h3>
      {status.keyConfigured && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            {t("speech.el.key.stored")} <span className="font-mono text-zinc-100">…{status.keyHint}</span>
          </p>
          {status.keyStatus === "payment_required" && <p className="text-xs text-amber-400">{t("speech.el.key.paymentRequired")}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void check()} disabled={busy} className={buttonClass}>
              {t("speech.el.key.check")}
            </button>
            <button onClick={() => setEditing(true)} disabled={busy} className={buttonClass}>
              {t("speech.el.key.replace")}
            </button>
            <button onClick={() => setConfirmRemove(true)} disabled={busy} className={`${buttonClass} text-red-300`}>
              {t("speech.el.key.remove")}
            </button>
          </div>
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* MaskedSecretInput, never a password field (Chrome autofills saved logins into password fields, BL-174). */}
            <MaskedSecretInput
              name="elevenlabs-api-key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
              placeholder={t("speech.el.key.placeholder")}
              aria-label={t("speech.el.key.inputAria")}
              className="w-80 max-w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-100 disabled:opacity-50"
            />
            <button onClick={() => void save()} disabled={busy || apiKey.trim().length < 20} className={primaryClass}>
              {t("speech.el.key.save")}
            </button>
            {status.keyConfigured && (
              <button onClick={() => setEditing(false)} disabled={busy} className={buttonClass}>
                {t("common.cancel")}
              </button>
            )}
          </div>
          <p className="text-xs text-zinc-500">{t("speech.el.key.hint")}</p>
        </div>
      )}
      {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmRemove && (
        <ConfirmDialog
          title={t("speech.el.key.removeTitle")}
          description={t("speech.el.key.removeDescription")}
          confirmLabel={t("speech.el.key.remove")}
          confirmVariant="danger"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={remove}
        />
      )}
    </div>
  );
}

function SpeechCard({ status, onChanged, onSubscription }: { status: Status; onChanged: () => Promise<void>; onSubscription: () => Promise<void> }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<LimitField, string>>(() => Object.fromEntries(LIMIT_FIELDS.map((f) => [f, String(status.limits[f])])) as Record<LimitField, string>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const savedKey = LIMIT_FIELDS.map((f) => status.limits[f]).join("|");
  useEffect(() => {
    setDrafts(Object.fromEntries(savedKey.split("|").map((value, i) => [LIMIT_FIELDS[i], value])) as Record<LimitField, string>);
  }, [savedKey]);

  const parsed = Object.fromEntries(LIMIT_FIELDS.map((f) => [f, parseCharLimit(f, drafts[f])])) as Record<LimitField, number | null>;
  const valid = LIMIT_FIELDS.every((f) => parsed[f] !== null);
  const dirty = valid && LIMIT_FIELDS.some((f) => parsed[f] !== status.limits[f]);

  async function put(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/elevenlabs-speech/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }, t("settings.saveFailed"), t);
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const labels: Record<LimitField, string> = {
    maxCharsPerJob: t("speech.el.limits.perJob"),
    maxCharsPerDay: t("speech.el.limits.perDay"),
    maxCharsPerMonth: t("speech.el.limits.perMonth"),
    maxActiveJobs: t("speech.el.limits.activeJobs"),
  };
  const numbers = new Intl.NumberFormat(t.language);
  const sub = status.subscription;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("speech.el.title")}
        <InfoTooltip>{t("speech.el.info")}</InfoTooltip>
      </h3>
      <div className="flex items-center gap-3">
        <ToggleSwitch checked={status.enabled} onChange={(next) => void put({ enabled: next }, next ? t("speech.el.turnedOn") : t("speech.el.turnedOff"))} disabled={busy} label={t("speech.el.switch")} />
        <span className="text-sm text-zinc-200">{t("speech.el.switch")}</span>
      </div>
      {status.enabled && !status.keyConfigured && <p className="text-xs text-amber-400">{t("speech.el.noKey")}</p>}
      {!status.gatewayEnabled && <p className="text-xs text-amber-400">{t("speech.el.gatewayOff")}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {LIMIT_FIELDS.map((field) => (
          <label key={field} className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="text"
              inputMode="numeric"
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
        <button onClick={() => void put(Object.fromEntries(LIMIT_FIELDS.map((f) => [f, parsed[f]])), t("common.saved"))} disabled={busy || !dirty} className={primaryClass}>
          {t("common.save")}
        </button>
        {!valid && <span className="text-xs text-red-400">{t("speech.el.limits.invalid")}</span>}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        {t("speech.el.format")}
        <select value={status.outputFormat} onChange={(e) => void put({ outputFormat: e.target.value }, t("common.saved"))} disabled={busy} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-sm text-zinc-100">
          {status.outputFormats.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-zinc-500">{t("speech.el.formatHint")}</p>
      <p className="text-sm text-zinc-300">
        {t("speech.el.usage", { today: numbers.format(status.usage.todayChars), month: numbers.format(status.usage.monthChars), usd: `$${status.usage.monthUsd.toFixed(2)}` })}
      </p>
      {sub && sub.errorCode ? (
        <p className="text-xs text-amber-400">{t("speech.el.subscriptionUnavailable", { code: sub.errorCode })}</p>
      ) : sub && sub.characterLimit != null ? (
        <p className="text-sm text-zinc-300">{t("speech.el.subscription", { used: numbers.format(sub.characterCount ?? 0), limit: numbers.format(sub.characterLimit), tier: sub.tier ?? "?" })}</p>
      ) : status.keyConfigured && status.gatewayEnabled ? (
        <button onClick={() => void onSubscription()} disabled={busy} className={buttonClass}>
          {t("speech.el.subscriptionLoad")}
        </button>
      ) : null}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
    </div>
  );
}
