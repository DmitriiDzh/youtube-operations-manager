"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-251 (docs/roadmap/plans/REMOTE_ACCESS_PLAN.md, ADR 0067): Settings → Общие → «Доступ с других устройств». The switch (off by
// default) and the password; both change only on the Mac itself (the server refuses a remote change too). A masked text field,
// not a password one (Chrome autofills saved logins into password fields, BL-174).

type Status = { enabled: boolean; passwordSet: boolean; ownerLogin: string | null; lockedUntil: string | null; thisRequestRemote: boolean };

const buttonClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

export function RemoteAccessSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/remote-access");
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(t, body, t("settings.loadFailed"), { showErrorField: false }));
    setStatus(body as Status);
  }, [t]);

  useEffect(() => {
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : t("settings.loadFailed")));
  }, [load, t]);

  async function put(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/remote-access", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("settings.saveFailed"), { showErrorField: false }));
      setStatus((current) => ({ ...(body as Status), thisRequestRemote: current?.thisRequestRemote ?? false }));
      setNotice(done);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">{error ? <p className="text-sm text-red-400">{error}</p> : <LoadingIndicator className="text-sm text-zinc-400" />}</div>;
  }
  const readOnly = status.thisRequestRemote;
  const tooShort = password.length > 0 && [...password].length < 8;
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("remoteAccess.title")}
        <InfoTooltip>{t("remoteAccess.info")}</InfoTooltip>
      </h3>
      {readOnly && <p className="text-xs text-amber-400">{t("remoteAccess.macOnly")}</p>}
      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={status.enabled}
          onChange={(next) => void put({ enabled: next }, next ? t("remoteAccess.turnedOn") : t("remoteAccess.turnedOff"))}
          disabled={busy || readOnly || (!status.passwordSet && !status.enabled)}
          label={t("remoteAccess.switch")}
        />
        <span className="text-sm text-zinc-200">{t("remoteAccess.switch")}</span>
      </div>
      <p className="text-xs text-zinc-400">{status.passwordSet ? t("remoteAccess.passwordSet") : t("remoteAccess.passwordNotSet")}</p>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <MaskedSecretInput
            name="remote-access-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            placeholder={t("remoteAccess.passwordLabel")}
            aria-label={t("remoteAccess.passwordLabel")}
            className={`w-72 max-w-full rounded-md border bg-zinc-800 px-2 py-1 text-sm text-zinc-100 ${tooShort ? "border-red-700" : "border-zinc-700"}`}
          />
          <button onClick={() => void put({ password }, t("remoteAccess.passwordSaved"))} disabled={busy || password.length === 0 || tooShort} className={buttonClass}>
            {t("remoteAccess.passwordSave")}
          </button>
          {tooShort && <span className="text-xs text-red-400">{t("remoteAccess.passwordTooShort")}</span>}
        </div>
      )}
      {status.ownerLogin && <p className="text-xs text-zinc-500">{t("remoteAccess.ownerLogin", { login: status.ownerLogin })}</p>}
      {status.lockedUntil && <p className="text-xs text-amber-400">{t("remoteAccess.locked", { until: new Date(status.lockedUntil).toLocaleString(t.language) })}</p>}
      <p className="text-xs text-zinc-500">{t("remoteAccess.steps")}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
    </div>
  );
}
