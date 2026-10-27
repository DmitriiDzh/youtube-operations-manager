"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { useUiText } from "./ui-text-provider";

type GithubTokenView = {
  state: "set" | "none" | "key_file_missing" | "key_file_invalid";
  login: string | null;
  status: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

const ROUTE = "/api/media-generation/github-token";
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";

/**
 * BL-230 (ADR 0043 amendment 1): Settings → Cloud APIs → GitHub. The read token pod runtime builds use for private GitHub
 * repositories. It is typed here only (no API or MCP path), checked with GitHub before it is saved, kept on this computer (never
 * synced), and never shown again: the card shows the GitHub login it belongs to and its expiry. Modelled on `HfTokenSettings`.
 */
export function GithubTokenSettings() {
  const { t } = useUiText();
  const [view, setView] = useState<GithubTokenView | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const call = useCallback(
    async (init?: RequestInit, url: string = ROUTE): Promise<GithubTokenView> => {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(t, body, t("githubToken.failed"), { showErrorField: false }));
      return body as GithubTokenView;
    },
    [t]
  );

  const load = useCallback(() => {
    call()
      .then((next) => {
        setView(next);
        setEditing(next.state !== "set");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("githubToken.failed")));
  }, [call, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<GithubTokenView>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      setView(next);
      setNotice(success);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("githubToken.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const next = await run(() => call({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token.trim() }) }), t("githubToken.saved"));
    if (next) {
      setToken("");
      setEditing(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("githubToken.title")}
        <InfoTooltip>{t("githubToken.help")}</InfoTooltip>
      </h3>
      {view?.state === "key_file_missing" && <p className="text-xs text-amber-400">{t("githubToken.keyFileMissing")}</p>}
      {view?.state === "key_file_invalid" && <p className="text-xs text-red-400">{t("githubToken.keyFileInvalid")}</p>}

      {view?.state === "set" && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            {t("githubToken.login")} <span className="font-mono text-zinc-100">{view.login ?? "—"}</span>
            {view.status === "invalid" && <span className="ml-2 text-red-400">{t("githubToken.invalid")}</span>}
          </p>
          <p className="text-xs text-zinc-400">
            {view.expiresAt ? t("githubToken.expiresAt", { date: formatDisplayDateTime(view.expiresAt) }) : t("githubToken.noExpiry")}
          </p>
          <p className="text-xs text-zinc-500">
            {view.updatedAt && t("githubToken.savedAt", { date: formatDisplayDateTime(view.updatedAt) })}
            {view.verifiedAt ? t("githubToken.lastVerified", { date: formatDisplayDateTime(view.verifiedAt) }) : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void run(() => call({ method: "POST" }, `${ROUTE}/test`), t("githubToken.checked"))} disabled={busy} className={primaryButton}>
              {busy ? t("media.common.working") : t("githubToken.check")}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className={secondaryButton}>
              {t("githubToken.replace")}
            </button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
              {t("githubToken.clear")}
            </button>
          </div>
        </div>
      )}

      {view && editing && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t("githubToken.field")}
            <MaskedSecretInput name="github-read-token" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} placeholder="github_pat_…" />
          </label>
          <p className="text-xs text-zinc-500">{t("githubToken.where")}</p>
          <p className="text-xs text-zinc-500">{t("githubToken.scope")}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} disabled={busy || token.trim().length < 40} className={primaryButton}>
              {busy ? t("common.saving") : t("githubToken.saveAndCheck")}
            </button>
            {view.state === "set" && (
              <button type="button" onClick={() => setEditing(false)} disabled={busy} className={secondaryButton}>
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {confirmClear && (
        <ConfirmDialog
          title={t("githubToken.clearTitle")}
          description={t("githubToken.clearDescription")}
          confirmLabel={t("githubToken.clear")}
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void run(() => call({ method: "DELETE" }), t("githubToken.removed")).then(() => setEditing(true));
          }}
        />
      )}
    </div>
  );
}
