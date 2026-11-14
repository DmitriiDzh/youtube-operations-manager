"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { MaskedSecretInput } from "./masked-secret-input";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-252 (ADR 0068, CROSS_POSTING_PLAN.md) stage 1: Settings → Channels → Social networks. The Meta app (App ID + App Secret,
// entered on the Mac only, never shown again), the redirect address to enter in the Meta app, and per channel: connect its
// Facebook Page + Instagram professional account (Meta's consent window, then the owner picks the Page), or disconnect.

type Network = "facebook" | "instagram";
type Account = { channelId: string; network: Network; displayName: string; username: string | null; externalId: string };
type Status = { metaApp: { configured: boolean; appId: string | null }; accounts: Account[]; callbackPath: string };
type Channel = { channelId: string; title: string };
type Pick = { channelId: string; pages: { pageId: string; pageName: string; instagram: { igUserId: string; username: string | null } | null }[] };

const inputClass = "w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

/** A Meta App ID is digits; an App Secret 32 hex characters (the same rule the server applies). */
export function validMetaApp(appId: string, appSecret: string): boolean {
  return /^\d{5,20}$/.test(appId.trim()) && /^[0-9a-fA-F]{32}$/.test(appSecret.trim());
}

/** The query the callback lands with (`socialPick` or `socialError`), removed from the address once read. */
function takeCallbackParams(): { pick: string | null; error: string | null } {
  if (typeof window === "undefined") return { pick: null, error: null };
  const url = new URL(window.location.href);
  const pick = url.searchParams.get("socialPick");
  const error = url.searchParams.get("socialError");
  if (pick || error) {
    url.searchParams.delete("socialPick");
    url.searchParams.delete("socialError");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }
  return { pick, error };
}

async function requestJson<T>(url: string, init: RequestInit | undefined, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function SocialAccountsSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<{ channelId: string; network: Network } | null>(null);
  const [pickId, setPickId] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        requestJson<Status>("/api/social", undefined, t("settings.loadFailed"), t),
        requestJson<{ channels?: Channel[] }>("/api/channels", undefined, t("settings.loadFailed"), t),
      ]);
      setStatus(s);
      setChannels(Array.isArray(c.channels) ? c.channels : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t("settings.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    const params = takeCallbackParams();
    if (params.error) {
      const key = `social.error.${params.error}` as UiTextKey;
      setError(params.error === "consent_cancelled" ? t(key) : t("social.error.generic", { code: params.error }));
    }
    if (params.pick) setPickId(params.pick);
    void load();
  }, [load, t]);

  useEffect(() => {
    if (!pickId) return;
    requestJson<Pick>(`/api/social/meta/pick?id=${encodeURIComponent(pickId)}`, undefined, t("social.pick.expired"), t).then(setPick, (e: unknown) => {
      setError(e instanceof Error ? e.message : t("social.pick.expired"));
      setPickId(null);
    });
  }, [pickId, t]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveApp = () =>
    run(async () => {
      await requestJson("/api/social/meta/app", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: appId.trim(), appSecret: appSecret.trim() }) }, t("settings.saveFailed"), t);
      setAppId("");
      setAppSecret("");
      setMessage(t("social.meta.saved"));
      await load();
    });

  const clearApp = () =>
    run(async () => {
      setConfirmClear(false);
      await requestJson("/api/social/meta/app", { method: "DELETE" }, t("settings.saveFailed"), t);
      await load();
    });

  const connect = (channelId: string) =>
    run(async () => {
      const { authorizeUrl } = await requestJson<{ authorizeUrl: string }>("/api/social/meta/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId }) }, t("social.error.generic", { code: "connect" }), t);
      window.location.assign(authorizeUrl);
    });

  const choose = (pageId: string) =>
    run(async () => {
      if (!pickId) return;
      await requestJson("/api/social/meta/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pickId, pageId }) }, t("social.pick.expired"), t);
      setPickId(null);
      setPick(null);
      setMessage(t("social.connected"));
      await load();
    });

  const disconnect = (target: { channelId: string; network: Network }) =>
    run(async () => {
      setConfirmDisconnect(null);
      await requestJson("/api/social/disconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) }, t("settings.saveFailed"), t);
      await load();
    });

  if (!status) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-base font-semibold text-zinc-100">{t("social.title")}</h3>
        {loadError ? <p className="text-sm text-red-400">{loadError}</p> : <LoadingIndicator />}
      </div>
    );
  }

  const callbackUrls = [`http://localhost:3000${status.callbackPath}`];
  const pickChannel = pick ? channels.find((c) => c.channelId === pick.channelId) : null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("social.title")}
        <InfoTooltip>{t("social.info")}</InfoTooltip>
      </h3>

      <section className="space-y-2">
        <h4 className="text-sm font-medium text-zinc-200">{t("social.meta.title")}</h4>
        <p className="text-sm text-zinc-400">{status.metaApp.configured ? t("social.meta.configured", { appId: status.metaApp.appId ?? "" }) : t("social.meta.notConfigured")}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("social.meta.appId")}
            <input className={inputClass} value={appId} onChange={(e) => setAppId(e.target.value)} inputMode="numeric" autoComplete="off" disabled={busy} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("social.meta.appSecret")}
            <MaskedSecretInput className={inputClass} value={appSecret} onChange={(e) => setAppSecret(e.target.value)} disabled={busy} />
          </label>
          <div className="flex gap-2">
            <button type="button" className={primaryClass} onClick={saveApp} disabled={busy || !validMetaApp(appId, appSecret)}>
              {t("social.meta.save")}
            </button>
            {status.metaApp.configured && (
              <button type="button" className={buttonClass} onClick={() => setConfirmClear(true)} disabled={busy}>
                {t("social.meta.clear")}
              </button>
            )}
          </div>
        </div>
        {(appId || appSecret) && !validMetaApp(appId, appSecret) && <p className="text-xs text-amber-400">{t("social.meta.invalid")}</p>}
        <p className="text-xs text-zinc-500">{t("social.meta.macOnly")}</p>
        <p className="text-xs text-zinc-400">{t("social.meta.redirects")}</p>
        <ul className="space-y-1">
          {callbackUrls.map((u) => (
            <li key={u}>
              <code className="break-all rounded bg-zinc-950 px-1.5 py-0.5 text-xs text-zinc-300 select-all">{u}</code>
            </li>
          ))}
        </ul>
      </section>

      {pick && (
        <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
          <h4 className="text-sm font-medium text-zinc-200">
            {t("social.pick.title")}
            {pickChannel ? ` — ${pickChannel.title}` : ""}
          </h4>
          {pick.pages.length === 0 && <p className="text-sm text-amber-400">{t("social.pick.none")}</p>}
          <ul className="space-y-2">
            {pick.pages.map((page) => (
              <li key={page.pageId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-zinc-200">
                  {page.pageName}
                  <span className="ml-2 text-xs text-zinc-400">{page.instagram ? t("social.pick.instagram", { username: page.instagram.username ?? page.instagram.igUserId }) : t("social.pick.noInstagram")}</span>
                </span>
                <button type="button" className={primaryClass} onClick={() => choose(page.pageId)} disabled={busy}>
                  {t("social.pick.choose")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        {channels.map((channel) => {
          const own = status.accounts.filter((a) => a.channelId === channel.channelId);
          return (
            <div key={channel.channelId} className="space-y-1 border-t border-zinc-800 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100">{channel.title}</span>
                <button type="button" className={buttonClass} onClick={() => connect(channel.channelId)} disabled={busy || !status.metaApp.configured}>
                  {own.length ? t("social.reconnect") : t("social.connect")}
                </button>
              </div>
              {own.length === 0 ? (
                <p className="text-xs text-zinc-500">{t("social.notConnected")}</p>
              ) : (
                <ul className="space-y-1">
                  {own.map((a) => (
                    <li key={a.network} className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-300">
                      <span>
                        {t(`social.network.${a.network}`)}: {a.username ? `@${a.username}` : a.displayName}
                      </span>
                      <button type="button" className={buttonClass} onClick={() => setConfirmDisconnect({ channelId: a.channelId, network: a.network })} disabled={busy}>
                        {t("social.disconnect")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      {message && <p className="text-sm text-emerald-400">{message}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {confirmClear && (
        <ConfirmDialog title={t("social.meta.clear")} description={t("social.meta.clearConfirm")} confirmLabel={t("social.meta.clear")} confirmVariant="danger" onCancel={() => setConfirmClear(false)} onConfirm={clearApp} />
      )}
      {confirmDisconnect && (
        <ConfirmDialog
          title={t("social.disconnect")}
          description={t("social.disconnectConfirm", { network: t(`social.network.${confirmDisconnect.network}`) })}
          confirmLabel={t("social.disconnect")}
          confirmVariant="danger"
          onCancel={() => setConfirmDisconnect(null)}
          onConfirm={() => disconnect(confirmDisconnect)}
        />
      )}
    </div>
  );
}
