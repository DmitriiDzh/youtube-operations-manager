"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { AgentTokenImportForm } from "./agent-token-import-form";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { useT } from "./ui-text-provider";
import { LoadingIndicator } from "./operation-progress";
import type { UiTextKey } from "@/lib/ui-text";
import type { ReactNode } from "react";

type TokenSummary = { tokenId: string; label: string | null; createdAt: string };

/** The texts a role's token card uses (each role has its own). */
export type RoleTokenTexts = {
  title: UiTextKey;
  info: UiTextKey;
  loadFailed: UiTextKey;
  statusUnknown: UiTextKey;
  rotateTitle: UiTextKey;
  revokeTitle: UiTextKey;
  rotateBody: UiTextKey;
  revokeBody: UiTextKey;
};

/**
 * Issue/rotate/revoke an agent ROLE's token (the Factory Operator, plan F2; the Producer, BL-161). The plaintext token is shown
 * exactly once, right after issuing; nothing can show it again. Self-contained (`AGENTS.md` §M): it owns its own fetch/save
 * against `endpoint` and is wrapped in its own error boundary by the caller. No native dialogs -- ConfirmDialog only.
 */
export function RoleAgentTokenSettings({
  endpoint,
  placeholder,
  texts,
  children,
}: {
  endpoint: string;
  placeholder: string;
  texts: RoleTokenTexts;
  /** Shown below the token controls (e.g. the Producer's call log). */
  children?: ReactNode;
}) {
  const t = useT();
  const [active, setActive] = useState<TokenSummary | null | undefined>(undefined);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<"rotate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  // A synchronous guard: two quick clicks (a double-click on "Rotate") must issue ONE token. `busy` state alone updates a render late.
  const inflight = useRef(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    setError(null);
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("load failed");
      setActive(((await res.json()) as { token: TokenSummary | null }).token);
    } catch {
      setLoadFailed(true);
      setError(t(texts.loadFailed));
    }
  }, [t, endpoint, texts.loadFailed]);

  useEffect(() => {
    load();
  }, [load]);

  async function issue() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { token?: TokenSummary & { token: string }; message?: string };
      if (!res.ok || !data.token) {
        setError(errorText(t, data, t("settingsCards.token.issueFailed"), { showErrorField: false }));
        return;
      }
      const { token, ...summary } = data.token;
      setActive(summary);
      setRevealed(token);
    } catch {
      setError(t("settingsCards.token.issueFailed"));
    } finally {
      inflight.current = false;
      setBusy(false);
      setPending(null);
    }
  }

  async function revoke() {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { message?: string };
        setError(errorText(t, data, t("settingsCards.token.revokeFailed"), { showErrorField: false }));
        return;
      }
      setActive(null);
      setRevealed(null);
    } catch {
      setError(t("settingsCards.token.revokeFailed"));
    } finally {
      inflight.current = false;
      setBusy(false);
      setPending(null);
    }
  }

  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch {
      setError(t("settingsCards.token.copyFailed"));
    }
  }

  if (active === undefined && !loadFailed) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <LoadingIndicator className="text-sm text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t(texts.title)}
        <InfoTooltip>{t(texts.info)}</InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="text-zinc-500">
          {loadFailed ? t(texts.statusUnknown) : active ? t("settingsCards.token.activeSince", { date: formatDisplayDateTime(active.createdAt) }) : t("settingsCards.token.noneIssued")}
        </span>
        <span className="flex-1" />
        {!active && !loadFailed && (
          <button
            onClick={issue}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? t("settingsCards.token.issuing") : t("settingsCards.token.issue")}
          </button>
        )}
        {active && (
          <>
            <button
              onClick={() => setPending("rotate")}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            >
              {t("settingsCards.token.rotate")}
            </button>
            <button
              onClick={() => setPending("revoke")}
              disabled={busy}
              className="rounded-md border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              {t("settingsCards.token.revoke")}
            </button>
          </>
        )}
      </div>

      {!loadFailed && (
        <AgentTokenImportForm<TokenSummary>
          endpoint={`${endpoint}/import`}
          placeholder={placeholder}
          replacesActive={Boolean(active)}
          onImported={(summary) => {
            setActive(summary);
            setRevealed(null);
          }}
        />
      )}

      {revealed && (
        <div className="space-y-1 rounded-lg border border-amber-900 bg-amber-950/30 p-2">
          <p className="text-xs text-amber-300">{t("settingsCards.token.copyNow")}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={revealed}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100"
            />
            <button onClick={copy} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500">
              {copied ? t("settingsCards.copied") : t("settingsCards.copy")}
            </button>
            <button onClick={() => setRevealed(null)} className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
              {t("settingsCards.token.hide")}
            </button>
          </div>
        </div>
      )}

      {children}

      {error && (
        <p role="alert" className="flex items-center gap-2 text-xs text-red-400">
          {error}
          {loadFailed && (
            <button onClick={() => load()} className="underline hover:text-red-300">
              {t("common.retry")}
            </button>
          )}
        </p>
      )}

      {pending && (
        <ConfirmDialog
          title={pending === "rotate" ? t(texts.rotateTitle) : t(texts.revokeTitle)}
          description={pending === "rotate" ? t(texts.rotateBody) : t(texts.revokeBody)}
          confirmLabel={pending === "rotate" ? t("settingsCards.token.rotate") : t("settingsCards.token.revoke")}
          confirmVariant="danger"
          onCancel={() => setPending(null)}
          onConfirm={pending === "rotate" ? issue : revoke}
        />
      )}
    </div>
  );
}
