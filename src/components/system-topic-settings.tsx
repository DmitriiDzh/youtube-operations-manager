"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md §2 item 3, ADR 0053): Settings → AI agent → «System (Telegram)». The bot token
// (a masked text field, never type="password"; it never comes back from the server, only `hasToken`), the three ids, the factory's
// commands.json path, this computer's listening switch, the poll state and the last 20 commands. Every text is a ui-text key.

type CommandStatus = "received" | "done" | "failed" | "refused" | "usage" | "unknown" | "not_available";
type CommandView = { updateId: number; text: string; status: CommandStatus; resultText: string | null; replyError: string | null; receivedAt: string };
type View = {
  ownerUserId: string | null;
  chatId: string | null;
  threadId: string | null;
  listening: boolean;
  commandsPath: string | null;
  hasToken: boolean;
  botId: string | null;
  serviceMode: boolean;
  active: boolean;
  droppedCount: number;
  lastPollAt: string | null;
  lastPollError: string | null;
  recent: CommandView[];
};
type Draft = { ownerUserId: string; chatId: string; threadId: string; listening: boolean; commandsPath: string };

const ROUTE = "/api/system-topic";
const POLL_MS = 15_000;
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";
const STATUS_TONE: Record<CommandStatus, string> = {
  received: "text-zinc-400",
  done: "text-emerald-400",
  failed: "text-red-400",
  refused: "text-amber-400",
  usage: "text-amber-400",
  unknown: "text-zinc-400",
  not_available: "text-zinc-400",
};

const draftOf = (view: View): Draft => ({
  ownerUserId: view.ownerUserId ?? "",
  chatId: view.chatId ?? "",
  threadId: view.threadId ?? "",
  listening: view.listening,
  commandsPath: view.commandsPath ?? "",
});

export function SystemTopicSettings() {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editingToken, setEditingToken] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const call = useCallback(
    async (url: string, init?: RequestInit): Promise<View> => {
      const res = await fetch(url, { cache: "no-store", ...init });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(t, body, t("settingsCards.systemTopic.failed")));
      return body as View;
    },
    [t]
  );

  const load = useCallback(async () => {
    try {
      const next = await call(ROUTE);
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

  async function run(action: () => Promise<View>, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      setView(next);
      setNotice(success);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingsCards.systemTopic.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function saveToken() {
    if (await run(() => call(`${ROUTE}/token`, json("PUT", { token: token.trim() })), t("settingsCards.systemTopic.tokenSaved"))) {
      setToken("");
      setEditingToken(false);
    }
  }

  async function saveSettings() {
    if (!draft) return;
    const ok = await run(() => call(ROUTE, json("PUT", draft)), t("settingsCards.systemTopic.saved"));
    if (ok) setDirty(false);
  }

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

  const field = (key: "ownerUserId" | "chatId" | "threadId" | "commandsPath", label: UiTextKey, numeric: boolean) => (
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

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.token")}</p>
        {view.hasToken && !editingToken && (
          <>
            <p className="text-xs text-zinc-400">{t("settingsCards.systemTopic.tokenSet", { botId: view.botId ?? "—" })}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setEditingToken(true)} disabled={busy} className={secondaryButton}>
                {t("settingsCards.systemTopic.tokenReplace")}
              </button>
              <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
                {t("settingsCards.systemTopic.tokenClear")}
              </button>
            </div>
          </>
        )}
        {(!view.hasToken || editingToken) && (
          <>
            {!view.hasToken && <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.tokenNone")}</p>}
            <MaskedSecretInput name="system-topic-bot-token" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
            <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.tokenWhere")}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void saveToken()} disabled={busy || token.trim().length < 20} className={primaryButton}>
                {busy ? t("common.saving") : t("settingsCards.systemTopic.tokenSave")}
              </button>
              {view.hasToken && (
                <button type="button" onClick={() => setEditingToken(false)} disabled={busy} className={secondaryButton}>
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {field("ownerUserId", "settingsCards.systemTopic.ownerUserId", true)}
        {field("chatId", "settingsCards.systemTopic.chatId", true)}
        {field("threadId", "settingsCards.systemTopic.threadId", true)}
      </div>
      {field("commandsPath", "settingsCards.systemTopic.commandsPath", false)}

      <div className="flex items-center gap-2">
        <ToggleSwitch
          label={t("settingsCards.systemTopic.listen")}
          checked={draft.listening}
          disabled={busy || (!view.serviceMode && !draft.listening)}
          onChange={(checked) => edit({ listening: checked })}
        />
        <span className="text-sm text-zinc-300">{t("settingsCards.systemTopic.listen")}</span>
      </div>
      {!view.serviceMode && <p className="text-xs text-amber-400">{t("settingsCards.systemTopic.notService")}</p>}

      <button type="button" onClick={() => void saveSettings()} disabled={busy || !dirty} className={primaryButton}>
        {busy ? t("common.saving") : t("settingsCards.systemTopic.save")}
      </button>

      <div className="space-y-1 text-xs text-zinc-400">
        <p className={view.active ? "text-emerald-400" : undefined}>{t(view.active ? "settingsCards.systemTopic.active" : "settingsCards.systemTopic.inactive")}</p>
        <p>{view.lastPollAt ? t("settingsCards.systemTopic.lastPoll", { time: formatDisplayDateTime(view.lastPollAt) }) : t("settingsCards.systemTopic.neverPolled")}</p>
        <p>{t("settingsCards.systemTopic.dropped", { count: String(view.droppedCount) })}</p>
        {view.lastPollError && <p className="text-red-400">{t("settingsCards.systemTopic.lastError", { error: view.lastPollError })}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-sm text-zinc-300">{t("settingsCards.systemTopic.recent")}</p>
        {view.recent.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.systemTopic.noCommands")}</p>}
        {view.recent.map((row) => (
          <div key={row.updateId} className="rounded-md border border-zinc-800 bg-zinc-950 p-2 text-xs">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-zinc-500">{formatDisplayDateTime(row.receivedAt)}</span>
              <span className="font-mono text-zinc-200">{row.text}</span>
              <span className={STATUS_TONE[row.status] ?? "text-zinc-400"}>{t(`settingsCards.systemTopic.status.${row.status}` as UiTextKey)}</span>
            </div>
            {row.resultText && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-400">{row.resultText}</pre>}
            {row.replyError && <p className="mt-1 text-red-400">{t("settingsCards.systemTopic.replyFailed", { error: row.replyError })}</p>}
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmClear && (
        <ConfirmDialog
          title={t("settingsCards.systemTopic.tokenClearTitle")}
          description={t("settingsCards.systemTopic.tokenClearBody")}
          confirmLabel={t("settingsCards.systemTopic.tokenClear")}
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void run(() => call(`${ROUTE}/token`, { method: "DELETE" }), t("settingsCards.systemTopic.tokenRemoved"));
          }}
        />
      )}
    </div>
  );
}
