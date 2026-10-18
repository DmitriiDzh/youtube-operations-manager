"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { CLOUD_CREDENTIALS_IMPORTED_EVENT } from "./cloud-credentials-transfer";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { useUiText } from "./ui-text-provider";

type HfTokenView = {
  state: "set" | "none" | "key_file_missing" | "key_file_invalid";
  user: string | null;
  status: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

const ROUTE = "/api/media-generation/hf-token";
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";

/**
 * BL-134 (FO-REQ-0028 §2A, ADR 0042): Settings → Cloud APIs → Hugging Face. The read token model pulls use for gated repos. It is
 * typed here only, checked with Hugging Face before it is saved, kept on this computer (never synced), and never shown again:
 * the card shows the Hugging Face user it belongs to.
 */
export function HfTokenSettings() {
  const { t } = useUiText();
  const [view, setView] = useState<HfTokenView | null>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const call = useCallback(
    async (init?: RequestInit, url: string = ROUTE): Promise<HfTokenView> => {
      const res = await fetch(url, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(t, body, t("hfToken.failed"), { showErrorField: false }));
      return body as HfTokenView;
    },
    [t]
  );

  const load = useCallback(() => {
    call()
      .then((next) => {
        setView(next);
        setEditing(next.state !== "set");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("hfToken.failed")));
  }, [call, t]);

  useEffect(() => {
    load();
    // Review of BL-134: a cloud-keys import may carry the token; reload like the RunPod and Gemini cards do.
    window.addEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, load);
    return () => window.removeEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, load);
  }, [load]);

  async function run(action: () => Promise<HfTokenView>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      setView(next);
      setNotice(success);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("hfToken.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const next = await run(() => call({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token.trim() }) }), t("hfToken.saved"));
    if (next) {
      setToken("");
      setEditing(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("hfToken.title")}
        <InfoTooltip>{t("hfToken.help")}</InfoTooltip>
      </h3>
      {view?.state === "key_file_missing" && <p className="text-xs text-amber-400">{t("hfToken.keyFileMissing")}</p>}
      {view?.state === "key_file_invalid" && <p className="text-xs text-red-400">{t("hfToken.keyFileInvalid")}</p>}

      {view?.state === "set" && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            {t("hfToken.user")} <span className="font-mono text-zinc-100">{view.user ?? "—"}</span>
            {view.status === "invalid" && <span className="ml-2 text-red-400">{t("hfToken.invalid")}</span>}
          </p>
          <p className="text-xs text-zinc-500">
            {view.updatedAt && t("hfToken.savedAt", { date: formatDisplayDateTime(view.updatedAt) })}
            {view.verifiedAt ? t("hfToken.lastVerified", { date: formatDisplayDateTime(view.verifiedAt) }) : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void run(() => call({ method: "POST" }, `${ROUTE}/test`), t("hfToken.checked"))} disabled={busy} className={primaryButton}>
              {busy ? t("media.common.working") : t("hfToken.check")}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className={secondaryButton}>
              {t("hfToken.replace")}
            </button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
              {t("hfToken.clear")}
            </button>
          </div>
        </div>
      )}

      {view && editing && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t("hfToken.field")}
            <MaskedSecretInput name="hf-read-token" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} placeholder="hf_…" />
          </label>
          <p className="text-xs text-zinc-500">{t("hfToken.where")}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} disabled={busy || token.trim().length < 20} className={primaryButton}>
              {busy ? t("common.saving") : t("hfToken.saveAndCheck")}
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
          title={t("hfToken.clearTitle")}
          description={t("hfToken.clearDescription")}
          confirmLabel={t("hfToken.clear")}
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void run(() => call({ method: "DELETE" }), t("hfToken.removed")).then(() => setEditing(true));
          }}
        />
      )}
    </div>
  );
}
