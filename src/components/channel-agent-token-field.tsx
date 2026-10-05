"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { AgentTokenImportForm } from "./agent-token-import-form";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";

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
      setError("Could not load the agent token status.");
    }
  }, [channelId]);

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
        setError(data.message ?? "Failed to issue a token");
        return;
      }
      const { token, ...summary } = data.token;
      setActive(summary);
      setRevealed(token);
    } catch {
      setError("Failed to issue a token");
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
        setError(data.message ?? "Failed to revoke the token");
        return;
      }
      setActive(null);
      setRevealed(null);
    } catch {
      setError("Failed to revoke the token");
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
      setError("Copy failed -- select the token and copy it manually.");
    }
  }

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          Agent token
          <InfoTooltip>
            The one token that binds an AI agent to this channel. An agent that presents this token to the
            app&apos;s MCP endpoint (as a Bearer credential) can only read and change this channel&apos;s data. It
            cannot see or switch to any other channel. Issuing a new token revokes the old one. The token is
            shown only once, right after issuing. It is stored only as a hash on this device. To use the same
            agent on another device, paste this token there with &quot;Use an existing token&quot;. Revoking a
            token applies only to the device where you revoke it.
          </InfoTooltip>
        </span>
        <span className="text-zinc-500">
          {active === undefined
            ? "Loading..."
            : active
              ? `active since ${formatDisplayDateTime(active.createdAt)}`
              : "none issued"}
        </span>
        <span className="flex-1" />
        {active === null && (
          <button
            onClick={issue}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? "Issuing..." : "Issue token"}
          </button>
        )}
        {active && (
          <>
            <button
              onClick={() => setPending("rotate")}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            >
              Rotate
            </button>
            <button
              onClick={() => setPending("revoke")}
              disabled={busy}
              className="rounded-md border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              Revoke
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
          <p className="text-xs text-amber-300">
            Copy this token now -- it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={revealed}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100"
            />
            <button onClick={copy} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500">
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={() => setRevealed(null)} className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
              Hide
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-2 text-xs text-red-400">
          {error}
          {loadFailed && (
            <button onClick={() => load()} className="underline hover:text-red-300">
              Retry
            </button>
          )}
        </p>
      )}

      {pending && (
        <ConfirmDialog
          title={pending === "rotate" ? "Rotate this channel's agent token?" : "Revoke this channel's agent token?"}
          description={
            pending === "rotate"
              ? "The current token stops working immediately. The agent needs the new token in its configuration."
              : "The agent using this token loses access to this channel on this device immediately. If the token was also entered on other devices, revoke it there too."
          }
          confirmLabel={pending === "rotate" ? "Rotate" : "Revoke"}
          confirmVariant="danger"
          onCancel={() => setPending(null)}
          onConfirm={pending === "rotate" ? issue : revoke}
        />
      )}
    </div>
  );
}
