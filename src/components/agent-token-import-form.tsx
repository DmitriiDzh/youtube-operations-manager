"use client";

import { errorText } from "@/lib/ui-text";
import { useRef, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { useT } from "./ui-text-provider";

/**
 * BL-130 (`docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md` §2.4) -- "Use an existing token": registers on
 * this device a token already issued on another one, so one agent configuration works everywhere.
 * Shared by the channel token field and the Factory Operator token settings (`AGENTS.md` §M). The
 * pasted value goes only into the POST body: it is never rendered back, logged, or kept after submit.
 * Replacing this device's active token asks for confirmation first, like Rotate (owner, msg 1584). No native dialogs.
 */
export function AgentTokenImportForm<TSummary>({
  endpoint,
  extraBody,
  placeholder,
  replacesActive,
  onImported,
}: {
  endpoint: string;
  extraBody?: Record<string, string>;
  placeholder: string;
  /** True when this device already has an active token that the import will replace. */
  replacesActive: boolean;
  onImported: (summary: TSummary) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Synchronous guard against a double submit (the `busy` state updates a render late).
  const inflight = useRef(false);

  function close() {
    setOpen(false);
    setValue("");
    setError(null);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inflight.current || value.trim() === "") return;
    if (replacesActive) {
      setConfirming(true);
      return;
    }
    void importToken();
  }

  async function importToken() {
    setConfirming(false);
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...extraBody, token: value }),
      });
      const data = (await res.json()) as { token?: TSummary; message?: string };
      if (!res.ok || !data.token) {
        setError(errorText(t, data, t("settingsCards.tokenImport.failed"), { showErrorField: false }));
        return;
      }
      onImported(data.token);
      close();
    } catch {
      setError(t("settingsCards.tokenImport.failed"));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
        {t("settingsCards.tokenImport.open")}
      </button>
    );
  }

  // The dialog renders OUTSIDE the <form>: its buttons have no explicit type, so inside the form they
  // would submit it (Cancel would re-open the dialog instead of closing it).
  return (
    <>
      <form onSubmit={submit} className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
        <p className="text-xs text-zinc-400">
          {replacesActive ? t("settingsCards.tokenImport.helpReplaces") : t("settingsCards.tokenImport.help")}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-label={t("settingsCards.tokenImport.aria")}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100"
          />
          <button
            type="submit"
            disabled={busy || value.trim() === ""}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? t("settingsCards.tokenImport.importing") : t("settingsCards.tokenImport.import")}
          </button>
          <button type="button" onClick={close} className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
            {t("common.cancel")}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </form>
      {confirming && (
        <ConfirmDialog
          title={t("settingsCards.tokenImport.confirmTitle")}
          description={t("settingsCards.tokenImport.confirmBody")}
          confirmLabel={t("settingsCards.tokenImport.confirmReplace")}
          confirmVariant="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={importToken}
        />
      )}
    </>
  );
}
