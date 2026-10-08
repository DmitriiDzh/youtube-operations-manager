"use client";

import { useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ChannelAgentTokenField } from "./channel-agent-token-field";
import { ChannelWorkspaceField } from "./channel-workspace-field";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { InfoTooltip } from "./info-tooltip";
import { activateStoredChannel, useConnectedChannels, type ConnectedChannel } from "./use-connected-channels";
import { LoadingIndicator } from "./operation-progress";
import { useConnectionHealth } from "./use-connection-health";
import { useT } from "./ui-text-provider";

/**
 * Settings-tab card for persistent channel connections (`docs/decisions/0010-persistent-channel-connections.md`,
 * owner instruction, 2026-09-23): connect any number of channels once, then switch between them
 * without re-consenting to Google every time, plus manage (disconnect) them. The topbar's
 * `channel-switcher.tsx` is the quick-switch counterpart, sharing this same
 * `useConnectedChannels`/`activateStoredChannel` logic (owner instruction, 2026-09-23:
 * "Функционал максимально должен использовать тот что уже есть сейчас") -- this card additionally
 * owns Disconnect, which the topbar dropdown deliberately doesn't expose.
 */
export function ChannelConnectionsSettings() {
  const t = useT();
  const { channels, refetch } = useConnectedChannels();
  const { health } = useConnectionHealth();
  const [error, setError] = useState<string | null>(null);
  const [activatingChannelId, setActivatingChannelId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectedChannel | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleActivate(channelId: string) {
    setActivatingChannelId(channelId);
    setError(null);
    try {
      const { ok } = await activateStoredChannel(channelId);
      if (ok) {
        await refetch();
      } else {
        setError(t("settingsCards.channels.activateFailed"));
      }
    } finally {
      setActivatingChannelId(null);
    }
  }

  async function handleConfirmDisconnect() {
    if (!pendingDisconnect) return;
    setDisconnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/channel-connections/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: pendingDisconnect.channelId }),
      });
      const data = (await res.json()) as { forceSignOut?: boolean; message?: string };
      if (!res.ok) {
        setError(data.message ?? t("settingsCards.disconnectFailed"));
        return;
      }
      setPendingDisconnect(null);
      if (data.forceSignOut) {
        await signOut();
        return;
      }
      await refetch();
    } catch {
      setError(t("settingsCards.disconnectFailed"));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("settingsCard.channels")}
        <InfoTooltip>{t("settingsCards.channels.info")}</InfoTooltip>
      </h3>

      {channels === null ? (
        <LoadingIndicator className="text-xs text-zinc-500" />
      ) : channels.length === 0 ? (
        <p className="text-xs text-zinc-500">{t("settingsCards.channels.none")}</p>
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => {
            const isActive = c.isActive;
            return (
              <li key={c.channelId} className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    {c.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumbnailUrl} alt="" className="h-8 w-8 shrink-0 rounded-full" />
                    ) : (
                      <div className="h-8 w-8 shrink-0 rounded-full bg-zinc-700" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">{c.title}</p>
                      <p className="truncate text-xs text-zinc-500">{c.connectedEmail}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {(() => {
                      const h = health?.find((x) => x.channelId === c.channelId);
                      if (!h || (h.state !== "reauth_required" && h.state !== "expiring_soon")) return null;
                      const dead = h.state === "reauth_required";
                      return (
                        <>
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${dead ? "bg-red-950/60 text-red-400" : "bg-amber-950/60 text-amber-400"}`}
                          >
                            {dead ? t("shell.reconnectNeeded") : t("settingsCards.channels.expiresIn", { days: h.daysLeft ?? "?" })}
                          </span>
                          <button
                            onClick={() => void signIn("google", undefined, { login_hint: c.connectedEmail })}
                            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
                          >
                            {t("settingsCards.reconnect")}
                          </button>
                        </>
                      );
                    })()}
                    {isActive ? (
                      <span className="rounded-full bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-400">
                        {t("settingsCards.channels.activeNow")}
                      </span>
                    ) : (
                      <button
                        onClick={() => handleActivate(c.channelId)}
                        disabled={activatingChannelId === c.channelId}
                        className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {activatingChannelId === c.channelId ? t("settingsCards.channels.activating") : t("settingsCards.channels.activate")}
                      </button>
                    )}
                    <button
                      onClick={() => setPendingDisconnect(c)}
                      className="rounded-md border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950"
                    >
                      {t("settingsCards.disconnect")}
                    </button>
                  </div>
                </div>
                <FeatureErrorBoundary label={t("settingsCards.channels.workspaceBoundary")}>
                  <ChannelWorkspaceField channelId={c.channelId} />
                </FeatureErrorBoundary>
                <FeatureErrorBoundary label={t("settingsCards.channels.tokenBoundary")}>
                  <ChannelAgentTokenField channelId={c.channelId} />
                </FeatureErrorBoundary>
              </li>
            );
          })}
        </ul>
      )}

      <button
        onClick={() => signIn("google")}
        className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
      >
        {t("settingsCards.channels.connectNew")}
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {pendingDisconnect && (
        <ConfirmDialog
          title={t("settingsCards.channels.disconnectTitle", { channel: pendingDisconnect.title })}
          description={t("settingsCards.channels.disconnectBody")}
          confirmLabel={disconnecting ? t("settingsCards.disconnecting") : t("settingsCards.disconnect")}
          confirmVariant="danger"
          onCancel={() => setPendingDisconnect(null)}
          onConfirm={handleConfirmDisconnect}
        />
      )}
    </div>
  );
}
