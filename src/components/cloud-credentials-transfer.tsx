"use client";

import { useRef, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { useT } from "./ui-text-provider";

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867, variant 1; ADR 0039 §6, extending BL-137 / ADR 0027): every cloud key of
// this computer -- RunPod with its S3 pair, and the Gemini key -- carried to another computer as ONE file encrypted under a
// password typed on both ends. The password lives only in these fields; the server never stores it, and no key ever reaches the
// browser (the server answers with ciphertext and public hints only).

type Section = "runpod" | "gemini" | "huggingface";

/** Fired on `window` after an import: the RunPod and Gemini cards reload their own views. */
export const CLOUD_CREDENTIALS_IMPORTED_EVENT = "cloud-credentials-imported";
type ExportAnswer = { file: { sections: Section[] }; skipped: Array<{ section: Section; message: string }> };
type ImportAnswer = { imported: Partial<Record<Section, unknown>> };

/** The file name an export downloads as: the date keeps several exports apart, `.ytmkeys` says what it is. */
export function cloudKeysFileName(now: Date): string {
  return `cloud-keys-${now.toISOString().slice(0, 10)}.ytmkeys`;
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";

export function CloudCredentialsTransfer() {
  const t = useT();
  const [mode, setMode] = useState<"idle" | "export" | "import">("idle");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Array<{ text: string; warning: boolean }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sectionName = (section: Section) =>
    t(section === "runpod" ? "cloudKeys.section.runpod" : section === "gemini" ? "cloudKeys.section.gemini" : "cloudKeys.section.huggingface");

  function reset(next: "idle" | "export" | "import") {
    setMode(next);
    setPassword("");
    setConfirmPassword("");
    setFile(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(t, data, fallback, { showErrorField: false }));
    return data as T;
  }

  async function doExport() {
    setBusy(true);
    setError(null);
    setNotices([]);
    try {
      const answer = await postJson<ExportAnswer>("/api/cloud-credentials/export", { password }, t("cloudKeys.exportFailed"));
      const url = URL.createObjectURL(new Blob([JSON.stringify(answer.file, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = cloudKeysFileName(new Date());
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Some WebKit versions drop the download when the blob URL is revoked in the same tick (BL-137 review).
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      reset("idle");
      setNotices([
        { text: t("cloudKeys.downloaded", { file: link.download, sections: answer.file.sections.map(sectionName).join(", ") }), warning: false },
        ...answer.skipped.map((s) => ({ text: t("cloudKeys.skipped", { section: sectionName(s.section), reason: s.message }), warning: true })),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cloudKeys.exportFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotices([]);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error(t("cloudKeys.notAFile"));
      }
      const answer = await postJson<ImportAnswer>("/api/cloud-credentials/import", { file: parsed, password }, t("cloudKeys.importFailed"));
      reset("idle");
      setNotices([{ text: t("cloudKeys.imported", { sections: (Object.keys(answer.imported) as Section[]).map(sectionName).join(", ") }), warning: false }]);
      // The RunPod and Gemini cards read their own state: a reload shows the imported keys there.
      window.dispatchEvent(new Event(CLOUD_CREDENTIALS_IMPORTED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cloudKeys.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  const tooShort = password.length < 12;
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("cloudKeys.title")}
        <InfoTooltip>{t("cloudKeys.info")}</InfoTooltip>
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => reset(mode === "export" ? "idle" : "export")} disabled={busy} className={secondaryButton}>
          {t("cloudKeys.export")}
        </button>
        <button type="button" onClick={() => reset(mode === "import" ? "idle" : "import")} disabled={busy} className={secondaryButton}>
          {t("cloudKeys.import")}
        </button>
      </div>
      {mode === "export" && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">{t("cloudKeys.exportExplanation")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <MaskedSecretInput name="cloud-keys-file-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder={t("cloudKeys.passwordPlaceholder")} />
            <MaskedSecretInput name="cloud-keys-file-password-repeat" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} placeholder={t("cloudKeys.repeatPlaceholder")} />
          </div>
          {confirmPassword && confirmPassword !== password && <p className="text-xs text-amber-400">{t("cloudKeys.passwordsDiffer")}</p>}
          <button type="button" onClick={doExport} disabled={busy || tooShort || password !== confirmPassword} className={primaryButton}>
            {busy ? t("cloudKeys.encrypting") : t("cloudKeys.download")}
          </button>
        </div>
      )}
      {mode === "import" && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">{t("cloudKeys.importExplanation")}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ytmkeys,application/json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border file:border-zinc-700 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-xs file:text-zinc-300"
          />
          <MaskedSecretInput name="cloud-keys-import-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder={t("cloudKeys.importPasswordPlaceholder")} />
          <button type="button" onClick={doImport} disabled={busy || !file || !password} className={primaryButton}>
            {busy ? t("cloudKeys.importing") : t("cloudKeys.importNow")}
          </button>
        </div>
      )}
      {notices.map((notice) => (
        <p key={notice.text} className={`text-xs ${notice.warning ? "text-amber-400" : "text-emerald-400"}`}>
          {notice.text}
        </p>
      ))}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
