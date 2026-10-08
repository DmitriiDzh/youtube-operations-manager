"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { CloudQuotaProgressPerMinute, type PerMinuteQuotaStatusView } from "./cloud-quota-progress";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { useConnectionHealth } from "./use-connection-health";
import { SettingsSectionRow } from "./settings-section-row";
import type { Translate } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type Status = { connected: false } | { connected: true; connectedEmail: string; scope: string; connectedAt: string };

// Mirrors the `CloudConnectionFailureReason` union the callback route
// (`src/app/api/cloud-connection/callback/route.ts`) can set -- kept in sync manually since the
// route is server-only and this component is client-only, so they cannot literally share the
// type. An unrecognized/missing reason falls back to the generic message below.
function cloudConnectionFailureMessage(t: Translate, reason: string | null): string {
  switch (reason) {
    case "oauth_denied":
      return t("settingsCards.cloud.fail.oauthDenied");
    case "missing_callback_params":
      return t("settingsCards.cloud.fail.missingParams");
    case "state_cookie_missing":
      return t("settingsCards.cloud.fail.stateCookie");
    case "AUTH_CALLBACK_INVALID":
      return t("settingsCards.cloud.fail.callbackInvalid");
    case "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED":
      return t("settingsCards.cloud.fail.tokenExchange");
    case "encryption_key_not_configured":
      return t("settingsCards.cloud.fail.encryptionKey");
    default:
      return t("settingsCards.cloud.fail.generic");
  }
}

/**
 * Settings-tab card for the Google Cloud connection (`docs/decisions/0008-cloud-connection.md`,
 * owner instruction, 2026-09-22): a single, device-persistent grant, entirely decoupled from the
 * per-channel YouTube login above -- connecting/disconnecting here never affects which channel is
 * active, and switching channels never affects this connection. YouTube's own limit/usage numbers
 * (`src/lib/cloud-quotas/`) are shown under the Data API reads / Live writes / Analytics reads
 * toggles elsewhere in Settings; this card shows Cloud Monitoring API's OWN quota (it is a real
 * Google API too, and checking the others' quota consumes its own -- owner instruction,
 * 2026-09-22: "Не вижу прогресс бара у Google Cloud connection") plus its own
 * `cloud_monitoring_reads` traffic count.
 */
export function CloudConnectionSettings() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [gatewayTraffic, setGatewayTraffic] = useState<GatewayTrafficWindowView[] | undefined>(undefined);
  const [monitoringQuota, setMonitoringQuota] = useState<PerMinuteQuotaStatusView | undefined>(undefined);
  const [disconnecting, setDisconnecting] = useState(false);
  // BL-126: the same 7-day check the channel logins get (the list carries the Cloud grant as `kind: "cloud"`).
  const { health } = useConnectionHealth();
  const cloudHealth = health?.find((h) => h.kind === "cloud") ?? null;
  const [error, setError] = useState<string | null>(null);
  // Read directly from window.location rather than `useSearchParams()` -- this page is statically
  // prerendered (`○ /dashboard` in the build output; since BL-149 the Settings layout), and `useSearchParams()` would force a
  // Suspense boundary just for this one-time post-redirect banner. A plain client-side read after
  // mount has no such requirement.
  const [callbackResult, setCallbackResult] = useState<string | null>(null);
  const [callbackReason, setCallbackReason] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const res = await fetch("/api/cloud-connection/status");
    if (!res.ok) return;
    setStatus((await res.json()) as Status);
  }, []);

  const fetchGatewayTraffic = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as {
      gatewayTraffic?: GatewayTrafficWindowView[];
      cloudQuotaStatus?: { monitoring: PerMinuteQuotaStatusView };
    };
    setGatewayTraffic(data.gatewayTraffic);
    setMonitoringQuota(data.cloudQuotaStatus?.monitoring);
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchGatewayTraffic();
    const params = new URLSearchParams(window.location.search);
    setCallbackResult(params.get("cloudConnection"));
    setCallbackReason(params.get("cloudConnectionReason"));
  }, [fetchStatus, fetchGatewayTraffic]);

  async function handleDisconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/cloud-connection/disconnect", { method: "POST" });
      const data = (await res.json()) as Status | { error?: string; message?: string };
      if (!res.ok) {
        setError("message" in data && data.message ? data.message : t("settingsCards.disconnectFailed"));
        return;
      }
      setStatus(data as Status);
    } catch {
      setError(t("settingsCards.disconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  }

  if (!status) return null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("settingsCards.cloud.title")}
          <InfoTooltip>{t("settingsCards.cloud.info")}</InfoTooltip>
        </h3>
      </div>

      {callbackResult === "connected" && (
        <p className="text-xs text-emerald-400">{t("settingsCards.cloud.connected")}</p>
      )}
      {callbackResult === "error" && (
        <p className="text-xs text-red-400">{cloudConnectionFailureMessage(t, callbackReason)}</p>
      )}

      {status.connected ? (
        <SettingsSectionRow
          left={
            <div className="space-y-2">
              <p className="text-sm text-zinc-300">
                {t("settingsCards.cloud.connectedAs")} <span className="font-mono text-zinc-100">{status.connectedEmail}</span>
              </p>
              <p className="text-xs text-zinc-500">{t("settingsCards.cloud.since", { date: formatDisplayDateTime(status.connectedAt) })}</p>
              {cloudHealth?.state === "reauth_required" && (
                <p className="text-xs text-red-400">
                  {t("settingsCards.cloud.expired")}
                </p>
              )}
              {cloudHealth?.state === "expiring_soon" && (
                <p className="text-xs text-amber-400">
                  {cloudHealth.daysLeft !== null && cloudHealth.daysLeft > 1
                    ? t("settingsCards.cloud.expiresInDays", { count: cloudHealth.daysLeft })
                    : t("settingsCards.cloud.expiresWithinDay")}
                </p>
              )}
              {(cloudHealth?.state === "reauth_required" || cloudHealth?.state === "expiring_soon") && (
                <a
                  href="/api/cloud-connection/start"
                  className="inline-block rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  {t("settingsCards.cloud.reconnect")}
                </a>
              )}
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50"
              >
                {disconnecting ? t("settingsCards.disconnecting") : t("settingsCards.disconnect")}
              </button>
            </div>
          }
          right={
            <>
              <GatewayTrafficStats
                size="lg"
                window={gatewayTraffic?.find((c) => c.category === "cloud_monitoring_reads")}
              />
              <CloudQuotaProgressPerMinute size="lg" status={monitoringQuota} />
            </>
          }
        />
      ) : (
        <a
          href="/api/cloud-connection/start"
          className="inline-block rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {t("settingsCards.cloud.connect")}
        </a>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
