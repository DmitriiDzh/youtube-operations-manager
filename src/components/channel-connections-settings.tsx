"use client";

import { useCallback, useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InfoTooltip } from "./info-tooltip";

type ConnectedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  connectedEmail: string;
  connectedAt: string;
  isActive: boolean;
};

/**
 * Settings-tab card for persistent channel connections (`docs/decisions/0010-persistent-channel-connections.md`,
 * owner instruction, 2026-09-23): connect any number of channels once, then switch between them
 * without re-consenting to Google every time. Distinct from the topbar's "Switch channel" button
 * (still always goes through Google's own account picker, unchanged) -- "Activate" here reuses an
 * already-stored identity instead.
 */
export function ChannelConnectionsSettings() {
  const [channels, setChannels] = useState<ConnectedChannel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activatingChannelId, setActivatingChannelId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectedChannel | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch("/api/channel-connections");
      if (!res.ok) return;
      const data = (await res.json()) as { channels: ConnectedChannel[] };
      setChannels(data.channels);
    } catch {
      // Non-fatal -- the card just keeps showing its last known list.
    }
  }, []);

  useEffect(() => {
    // A channel only gets linked into `channels.connectedUserId` (the field `listConnectedChannels`
    // filters on) by `channel-sync`'s own "mine" resolution -- `GET /api/youtube/channel-info`
    // (fetched automatically on every dashboard load) only ever updates `users.selectedChannelId`
    // (ADR 0004), never that link. Before this fix, a channel connected via "Connect a new
    // channel" (a plain Google sign-in) never appeared here at all unless the operator separately
    // visited the Content/Languages tab, which happens to also trigger this same sync -- found by
    // the project owner live-testing this exact flow. Calling it here too (mine-path, no
    // `channelId`) makes this card self-contained; it runs once per dashboard session, the same
    // cost tradeoff already accepted for this Settings tab's other cards that fetch on load.
    async function syncThenFetch() {
      try {
        await fetch("/api/channels/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        // Non-fatal -- a pre-existing connection still lists correctly either way; this only
        // affects whether a *just-connected* channel shows up immediately.
      }
      await fetchChannels();
    }
    void syncThenFetch();
  }, [fetchChannels]);

  async function handleActivate(channelId: string) {
    setActivatingChannelId(channelId);
    setError(null);
    try {
      const result = await signIn("channel-connections", { channelId, redirect: false });
      if (result?.error) {
        setError("Could not activate this channel. It may need to be reconnected.");
      } else {
        await fetchChannels();
      }
    } catch {
      setError("Could not activate this channel. It may need to be reconnected.");
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
        setError(data.message ?? "Disconnect failed");
        return;
      }
      setPendingDisconnect(null);
      if (data.forceSignOut) {
        await signOut();
        return;
      }
      await fetchChannels();
    } catch {
      setError("Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        Channels
        <InfoTooltip>
          Every channel you connect here stays connected until you explicitly disconnect it --
          switching between them never requires signing in to Google again. Connecting a new
          channel still goes through Google&rsquo;s own consent screen once; the topbar&rsquo;s
          &ldquo;Switch channel&rdquo; button is unchanged and always asks Google directly.
        </InfoTooltip>
      </h3>

      {channels === null ? (
        <p className="text-xs text-zinc-500">Loading...</p>
      ) : channels.length === 0 ? (
        <p className="text-xs text-zinc-500">No channels connected yet.</p>
      ) : (
        <ul className="space-y-2">
          {channels.map((c) => {
            const isActive = c.isActive;
            return (
              <li
                key={c.channelId}
                className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3"
              >
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
                  {isActive ? (
                    <span className="rounded-full bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-400">
                      Active now
                    </span>
                  ) : (
                    <button
                      onClick={() => handleActivate(c.channelId)}
                      disabled={activatingChannelId === c.channelId}
                      className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {activatingChannelId === c.channelId ? "Activating..." : "Activate"}
                    </button>
                  )}
                  <button
                    onClick={() => setPendingDisconnect(c)}
                    className="rounded-md border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950"
                  >
                    Disconnect
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <button
        onClick={() => signIn("google")}
        className="rounded-md border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
      >
        Connect a new channel
      </button>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {pendingDisconnect && (
        <ConfirmDialog
          title={`Disconnect "${pendingDisconnect.title}"?`}
          description="This revokes its stored Google access. You'll need to sign in again with Google to reconnect it."
          confirmLabel={disconnecting ? "Disconnecting..." : "Disconnect"}
          confirmVariant="danger"
          onCancel={() => setPendingDisconnect(null)}
          onConfirm={handleConfirmDisconnect}
        />
      )}
    </div>
  );
}
