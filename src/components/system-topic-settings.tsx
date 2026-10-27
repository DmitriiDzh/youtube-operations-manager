"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1; owner msg 3607): Settings → AI agent → «System (Telegram)».
// The three ids, the requests folder, this computer's switch, the hub's relay secret (generated here, shown once; the server keeps
// only its hash), the relay's state, the requests approved in the topic with Confirm / Deny (a paid call runs only after both the
// owner's `approve` in the topic and this Confirm), the last requests and commands. Every text is a ui-text key.

type CommandStatus = "received" | "done" | "refused" | "usage" | "unknown" | "hub";
type RequestState = "posted" | "approved_in_topic" | "confirmed" | "done" | "failed" | "denied" | "expired" | "refused";
type CommandView = { updateId: number; text: string; status: CommandStatus; resultText: string | null; receivedAt: string };
type RequestView = {
  id: string;
  action: string | null;
  args: unknown;
  hash: string | null;
  createdAt: string | null;
  requestedBy: string | null;
  reason: string | null;
  agentEstimateUsd: number | null;
  estimateUsd: number | null;
  state: RequestState;
  refusal: string | null;
  seenAt: string;
  result: unknown;
};
type View = {
  ownerUserId: string | null;
  chatId: string | null;
  threadId: string | null;
  enabled: boolean;
  requestsPath: string | null;
  relaySecret: { set: boolean; createdAt: string | null };
  serviceMode: boolean;
  active: boolean;
  droppedCount: number;
  lastInboundAt: string | null;
  lastOutboxAt: string | null;
  lastScanAt: string | null;
  lastScanError: string | null;
  recent: CommandView[];
  requests: { waiting: RequestView[]; recent: RequestView[] };
};
type Draft = { ownerUserId: string; chatId: string; threadId: string; enabled: boolean; requestsPath: string };

const ROUTE = "/api/system-topic";
const POLL_MS = 10_000;
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";
const STATE_TONE: Record<RequestState, string> = {
  posted: "text-zinc-400",
  approved_in_topic: "text-amber-400",
  confirmed: "text-zinc-300",
  done: "text-emerald-400",
  failed: "text-red-400",
  denied: "text-zinc-400",
  expired: "text-zinc-400",
  refused: "text-amber-400",
};

const draftOf = (view: View): Draft => ({
  ownerUserId: view.ownerUserId ?? "",
  chatId: view.chatId ?? "",
  threadId: view.threadId ?? "",
  enabled: view.enabled,
  requestsPath: view.requestsPath ?? "",
});
const usd = (value: number | null) => (value === null ? "—" : `$${value.toFixed(2)}`);

export function SystemTopicSettings() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirming, setConfirming] = useState<RequestView | null>(null);

  const call = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(url, { cache: "no-store", ...init });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(t, body, t("settingsCards.systemTopic.failed")));
      return body as T;
    },
    [t]
  );

  const load = useCallback(async () => {
    try {
      const next = await call<View>(ROUTE);
      setView(next);
      // A poll never overwrites what the owner is typing.
      setDraft((current) => (current && dirty ? current : draftOf(next)));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsCards.systemTopic.failed"));
    }
  }, [call, dirty, t]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function run<T>(action: () => Promise<T>, after: (result: T) => void): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      after(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsCards.systemTopic.failed"));
    } finally {
      setBusy(false);
    }
  }

  const post = (url: string, body?: unknown): RequestInit => ({ method: url === ROUTE ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };

  if (!view || !draft) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="text-base font-semibold text-zinc-100">{t("settingsCards.systemTopic.title")}</h3>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  const time = (value: string | null) => (value ? formatDisplayDateTime(value) : t("settingsCards.systemTopic.never"));
  const field = (key: keyof Omit<Draft, "enabled">, label: UiTextKey, numeric: boolean) => (
    <label className="block text-xs text-zinc-400">
      {t(label)}
      <input
        type="text"
        inputMode={numeric ? "numeric" : undefined}
        autoComplete="off"
        spellCheck={false}
        value={draft[key]}
        onChange={(e) => edit({ [key]: e.target.value })}
        className={inputClass}
      />
    </label>
  );

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("settingsCards.systemTopic.title")}
        <InfoTooltip>{t("settingsCards.systemTopic.info")}</InfoTooltip>
      </h3>

      <div className="grid gap-3 sm:grid-cols-3">
        {field("ownerUserId", "settingsCards.systemTopic.ownerUserId", true)}
        {field("chatId", "settingsCards.systemTopic.chatId", true)}
        {field("threadId", "settingsCards.systemTopic.threadId", true)}
      </div>
      {field("requestsPath", "settingsCards.systemTopic.requestsPath", false)}
      <div className="flex items-center gap-2">
        <ToggleSwitch label={t("settingsCards.systemTopic.enable")} checked={draft.enabled} disabled={busy || (!view.serviceMode && !draft.enabled)} onChange={(checked) => edit({ enabled: checked })} />
        <span className="text-sm text-zinc-300">{t("settingsCards.systemTopic.enable")}</span>
      </div>
      {!view.serviceMode && <p className="text-xs text-amber-400">{t("settingsCards.systemTopic.notService")}</p>}
      <button
        type="button"
        disabled={busy || !dirty}
        className={primaryButton}
        onClick={() =>
          void run(
            () => call<View>(ROUTE, post(ROUTE, draft)),
            (next) => {
              setView(next);
              setDirty(false);
              setNotice(t("settingsCards.systemTopic.saved"));
            }
          )
        }
      >
        {busy ? t("common.saving") : t("settingsCards.systemTopic.save")}
      </button>

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.relayTitle")}</p>
        <p className="text-xs text-zinc-400">
          {view.relaySecret.set ? t("settingsCards.systemTopic.relaySet", { time: time(view.relaySecret.createdAt) }) : t("settingsCards.systemTopic.relayNone")}
        </p>
        {newSecret ? (
          <div className="space-y-2 rounded-md border border-amber-800 bg-amber-950/30 p-2">
            <input readOnly aria-label={t("settingsCards.systemTopic.relayAria")} value={newSecret} onFocus={(e) => e.target.select()} className={`${inputClass} font-mono`} />
            <p className="text-xs text-amber-300">{t("settingsCards.systemTopic.relayShownOnce")}</p>
            <button type="button" className={secondaryButton} onClick={() => setNewSecret(null)}>
              {t("settingsCards.systemTopic.relayDone")}
            </button>
          </div>
        ) : (
          <button type="button" disabled={busy} className={secondaryButton} onClick={() => (view.relaySecret.set ? setConfirmRegenerate(true) : void generate())}>
            {t(view.relaySecret.set ? "settingsCards.systemTopic.relayRegenerate" : "settingsCards.systemTopic.relayGenerate")}
          </button>
        )}
      </div>

      <div className="space-y-1 text-xs text-zinc-400">
        <p className={view.active ? "text-emerald-400" : undefined}>{t(view.active ? "settingsCards.systemTopic.active" : "settingsCards.systemTopic.inactive")}</p>
        <p>{t("settingsCards.systemTopic.lastInbound", { time: time(view.lastInboundAt) })}</p>
        <p>{t("settingsCards.systemTopic.lastOutbox", { time: time(view.lastOutboxAt) })}</p>
        <p>{t("settingsCards.systemTopic.lastScan", { time: time(view.lastScanAt) })}</p>
        {view.lastScanError && <p className="text-red-400">{t("settingsCards.systemTopic.scanError", { error: view.lastScanError })}</p>}
        <p>{t("settingsCards.systemTopic.dropped", { count: String(view.droppedCount) })}</p>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.waiting")}</p>
        {view.requests.waiting.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.noWaiting")}</p>}
        {view.requests.waiting.map((request) => (
          <div key={request.id} className="space-y-1 rounded-md border border-amber-900 bg-zinc-950 p-2 text-xs">
            <p className="font-mono text-zinc-200">{t("settingsCards.systemTopic.requestLine", { id: request.id, action: request.action ?? "—", requestedBy: request.requestedBy ?? "—" })}</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-400">{JSON.stringify(request.args, null, 2)}</pre>
            <p className="text-zinc-300">{t("settingsCards.systemTopic.estimate", { usd: usd(request.estimateUsd) })}</p>
            {request.agentEstimateUsd !== null && <p className="text-zinc-500">{t("settingsCards.systemTopic.agentEstimate", { usd: usd(request.agentEstimateUsd) })}</p>}
            <p className="text-zinc-500">
              {t("settingsCards.systemTopic.hash", { hash: request.hash ?? "—" })} · {t("settingsCards.systemTopic.created", { time: time(request.createdAt) })}
            </p>
            {request.reason && <p className="text-zinc-400">{request.reason}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" disabled={busy} className={primaryButton} onClick={() => setConfirming(request)}>
                {t("settingsCards.systemTopic.confirm")}
              </button>
              <button type="button" disabled={busy} className={dangerButton} onClick={() => void act(request.id, "deny")}>
                {t("settingsCards.systemTopic.deny")}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.recentRequests")}</p>
        {view.requests.recent.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.noRequests")}</p>}
        {view.requests.recent.map((request) => (
          <div key={request.id} className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-zinc-500">{formatDisplayDateTime(request.seenAt)}</span>
              <span className="font-mono text-zinc-200">{request.id}</span>
              <span className="text-zinc-400">{request.action ?? "—"}</span>
              <span className={STATE_TONE[request.state] ?? "text-zinc-400"}>{t(`settingsCards.systemTopic.state.${request.state}` as UiTextKey)}</span>
              <span className="text-zinc-500">{usd(request.estimateUsd)}</span>
            </div>
            {request.refusal && <p className="mt-1 text-amber-400">{request.refusal}</p>}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.recent")}</p>
        {view.recent.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.noCommands")}</p>}
        {view.recent.map((row) => (
          <div key={row.updateId} className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-zinc-500">{formatDisplayDateTime(row.receivedAt)}</span>
              <span className="font-mono text-zinc-200">{row.text}</span>
              <span className="text-zinc-400">{t(`settingsCards.systemTopic.status.${row.status}` as UiTextKey)}</span>
            </div>
            {row.resultText && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-400">{row.resultText}</pre>}
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmRegenerate && (
        <ConfirmDialog
          title={t("settingsCards.systemTopic.relayConfirmTitle")}
          description={t("settingsCards.systemTopic.relayConfirmBody")}
          confirmLabel={t("settingsCards.systemTopic.relayRegenerate")}
          confirmVariant="danger"
          onCancel={() => setConfirmRegenerate(false)}
          onConfirm={() => {
            setConfirmRegenerate(false);
            void generate();
          }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title={t("settingsCards.systemTopic.confirmTitle")}
          description={t("settingsCards.systemTopic.confirmBody", { action: confirming.action ?? "—", requestedBy: confirming.requestedBy ?? "—", usd: usd(confirming.estimateUsd) })}
          confirmLabel={t("settingsCards.systemTopic.confirm")}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const id = confirming.id;
            setConfirming(null);
            void act(id, "confirm");
          }}
        />
      )}
    </div>
  );

  function generate() {
    return run(
      () => call<{ secret: string; view: View }>(`${ROUTE}/relay-secret`, post(`${ROUTE}/relay-secret`)),
      (result) => {
        setNewSecret(result.secret);
        setView(result.view);
      }
    );
  }

  function act(id: string, what: "confirm" | "deny") {
    return run(
      () => call<{ request: RequestView; view: View }>(`${ROUTE}/requests/${encodeURIComponent(id)}/${what}`, post(`${ROUTE}/requests/${id}/${what}`)),
      (result) => {
        setView(result.view);
        setNotice(t("settingsCards.systemTopic.confirmed", { id: result.request.id, state: t(`settingsCards.systemTopic.state.${result.request.state}` as UiTextKey) }));
      }
    );
  }
}
