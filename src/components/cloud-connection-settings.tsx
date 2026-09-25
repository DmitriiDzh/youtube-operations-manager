"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudQuotaProgressPerMinute, type PerMinuteQuotaStatusView } from "./cloud-quota-progress";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { SettingsSectionRow } from "./settings-section-row";

type Status = { connected: false } | { connected: true; connectedEmail: string; scope: string; connectedAt: string };

// Mirrors the `CloudConnectionFailureReason` union the callback route
// (`src/app/api/cloud-connection/callback/route.ts`) can set -- kept in sync manually since the
// route is server-only and this component is client-only, so they cannot literally share the
// type. An unrecognized/missing reason falls back to the generic message below.
function cloudConnectionFailureMessage(reason: string | null): string {
  switch (reason) {
    case "oauth_denied":
      return "Google declined or cancelled the request (e.g. consent was not granted).";
    case "missing_callback_params":
      return "Google's redirect back to this app was missing expected parameters. Try connecting again.";
    case "state_cookie_missing":
      return "The connection attempt expired or its cookie was blocked. Try connecting again (don't wait too long on Google's consent screen).";
    case "AUTH_CALLBACK_INVALID":
      return "The callback could not be verified (state mismatch). Try connecting again from a fresh click, not a reused/bookmarked link.";
    case "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED":
      return "Google rejected the token exchange. This usually means this app's Cloud connection redirect URI isn't registered in Google Cloud Console's OAuth client yet (see docs/decisions/0008-cloud-connection.md), or the authorization code already expired.";
    case "encryption_key_not_configured":
      return "CLOUD_CONNECTION_ENCRYPTION_KEY is not configured on this server. Set it and restart the app.";
    default:
      return "Connection failed. Please try again.";
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
  const [status, setStatus] = useState<Status | null>(null);
  const [gatewayTraffic, setGatewayTraffic] = useState<GatewayTrafficWindowView[] | undefined>(undefined);
  const [monitoringQuota, setMonitoringQuota] = useState<PerMinuteQuotaStatusView | undefined>(undefined);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read directly from window.location rather than `useSearchParams()` -- this page is statically
  // prerendered (`○ /dashboard` in the build output), and `useSearchParams()` would force a
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
        setError("message" in data && data.message ? data.message : "Disconnect failed");
        return;
      }
      setStatus(data as Status);
    } catch {
      setError("Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  if (!status) return null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Google Cloud connection
          <InfoTooltip>
            A single, device-persistent grant powering the real Google Cloud quota numbers shown
            under the toggles above. Independent of the YouTube channel login above: connecting or
            disconnecting here does not affect which channel is active, and switching channels
            never revokes this grant.
          </InfoTooltip>
        </h3>
      </div>

      {callbackResult === "connected" && (
        <p className="text-xs text-emerald-400">Connected.</p>
      )}
      {callbackResult === "error" && (
        <p className="text-xs text-red-400">{cloudConnectionFailureMessage(callbackReason)}</p>
      )}

      {status.connected ? (
        <SettingsSectionRow
          left={
            <div className="space-y-2">
              <p className="text-sm text-zinc-300">
                Connected as <span className="font-mono text-zinc-100">{status.connectedEmail}</span>
              </p>
              <p className="text-xs text-zinc-500">Since {new Date(status.connectedAt).toLocaleString()}</p>
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
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
          Connect Google Cloud
        </a>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
