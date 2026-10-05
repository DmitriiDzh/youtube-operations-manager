"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";

type TokenSummary = { tokenId: string; label: string | null; createdAt: string };

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` F2) -- issue/rotate/revoke
 * the Factory Operator role's agent token. The plaintext token is shown exactly once, right after
 * issuing; nothing can show it again. Self-contained (`AGENTS.md` §M): it owns its own fetch/save
 * against `/api/factory-agent-token` and is wrapped in its own error boundary by the caller. No
 * native dialogs -- ConfirmDialog only.
 */
export function FactoryAgentTokenSettings() {
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
      const res = await fetch("/api/factory-agent-token");
      if (!res.ok) throw new Error("load failed");
      setActive(((await res.json()) as { token: TokenSummary | null }).token);
    } catch {
      setLoadFailed(true);
      setError("Could not load the Factory Operator token status.");
    }
  }, []);

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
      const res = await fetch("/api/factory-agent-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
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
      const res = await fetch("/api/factory-agent-token", { method: "DELETE" });
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
      setError("Copy failed -- select the token and copy it manually.");
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
        Factory Operator token
        <InfoTooltip>
          The token for the Factory Operator role, a read-only agent that is not tied to any channel. It
          works only on its own endpoint (/api/mcp/factory) and cannot use a channel agent&apos;s
          tools or data; a channel agent&apos;s token does not work there either. Issuing a new token
          revokes the old one. The token is shown only once, right after issuing, and is stored only as a
          hash on this device. It follows the same MCP connection on/off switch as channel agents.
        </InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
        <span className="text-zinc-500">
          {loadFailed ? "status unknown" : active ? `active since ${formatDisplayDateTime(active.createdAt)}` : "none issued"}
        </span>
        <span className="flex-1" />
        {!active && !loadFailed && (
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

      {revealed && (
        <div className="space-y-1 rounded-lg border border-amber-900 bg-amber-950/30 p-2">
          <p className="text-xs text-amber-300">Copy this token now -- it will not be shown again.</p>
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
        <p role="alert" className="flex items-center gap-2 text-xs text-red-400">
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
          title={pending === "rotate" ? "Rotate the Factory Operator token?" : "Revoke the Factory Operator token?"}
          description={
            pending === "rotate"
              ? "The current token stops working immediately. The Factory Operator needs the new token in its configuration."
              : "The Factory Operator loses access immediately. Channel agents are not affected."
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
