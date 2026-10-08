"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { AgentTokenImportForm } from "./agent-token-import-form";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { useT } from "./ui-text-provider";

type TokenSummary = { tokenId: string; channelId: string; label: string | null; createdAt: string };

// Every channel row mounts one field -- share one in-flight GET between them (same pattern as
// channel-workspace-field.tsx).
let inflightList: Promise<TokenSummary[]> | null = null;

function fetchTokenList(): Promise<TokenSummary[]> {
  if (!inflightList) {
    inflightList = (async () => {
      const res = await fetch("/api/agent-tokens");
      if (!res.ok) throw new Error("load failed");
      return ((await res.json()) as { tokens: TokenSummary[] }).tokens;
    })().finally(() => {
      inflightList = null;
    });
  }
  return inflightList;
}

/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.1) -- issue/rotate/revoke the one agent
 * token bound to this channel (one agent = one channel). The plaintext token is shown exactly once,
 * right after issuing; nothing can show it again. Rendered inside its own error boundary per
 * channel row (`AGENTS.md` §M). No native dialogs -- ConfirmDialog only.
 */
export function ChannelAgentTokenField({ channelId }: { channelId: string }) {
  const t = useT();
  const [active, setActive] = useState<TokenSummary | null | undefined>(undefined);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<"rotate" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    setError(null);
    try {
      const tokens = await fetchTokenList();
      setActive(tokens.find((token) => token.channelId === channelId) ?? null);
    } catch {
      setLoadFailed(true);
      setError(t("settingsCards.channelToken.loadFailed"));
    }
  }, [channelId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId }),
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
      setBusy(false);
      setPending(null);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
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

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          {t("settingsCards.channelToken.title")}
          <InfoTooltip>{t("settingsCards.channelToken.info")}</InfoTooltip>
        </span>
        <span className="text-zinc-500">
          {active === undefined
            ? t("common.loading")
            : active
              ? t("settingsCards.token.activeSince", { date: formatDisplayDateTime(active.createdAt) })
              : t("settingsCards.token.noneIssued")}
        </span>
        <span className="flex-1" />
        {active === null && (
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

      {active !== undefined && !loadFailed && (
        <AgentTokenImportForm<TokenSummary>
          endpoint="/api/agent-tokens/import"
          extraBody={{ channelId }}
          placeholder="ytom_ch_..."
          replacesActive={active !== null}
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

      {error && (
        <p className="flex items-center gap-2 text-xs text-red-400">
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
          title={pending === "rotate" ? t("settingsCards.channelToken.rotateTitle") : t("settingsCards.channelToken.revokeTitle")}
          description={
            pending === "rotate"
              ? t("settingsCards.channelToken.rotateBody")
              : t("settingsCards.channelToken.revokeBody")
          }
          confirmLabel={pending === "rotate" ? t("settingsCards.token.rotate") : t("settingsCards.token.revoke")}
          confirmVariant="danger"
          onCancel={() => setPending(null)}
          onConfirm={pending === "rotate" ? issue : revoke}
        />
      )}
    </div>
  );
}
