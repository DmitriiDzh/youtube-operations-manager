"use client";

import { useCallback, useEffect, useState } from "react";

type SyncedChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
  connectedUserId: string | null;
  connectedAt: string;
  lastSyncedAt: string | null;
};

type SyncedVideo = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, { url: string; width: number | null; height: number | null }>;
  existingLocalizationLanguages: string[];
  lastSyncedAt: string;
  etag: string | null;
};

// A tab switch already re-mounts this component (dashboard/page.tsx's conditional tab
// rendering), so this only needs to decide, once per mount, whether the already-local data is
// fresh enough to skip a real YouTube API call -- auto-resyncing on every single mount would
// spend real, finite quota on every tab click (docs/roadmap/plans/TAB_REFRESH_AND_CHANNEL_UI_PLAN.md
// §4, owner-approved policy). "Sync now" remains available for an explicit forced refresh.
const AUTO_RESYNC_STALENESS_MS = 20 * 60 * 1000;

export function ChannelSync() {
  const [channels, setChannels] = useState<SyncedChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [videos, setVideos] = useState<SyncedVideo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  const fetchVideos = useCallback(async (channelId: string) => {
    if (!channelId) {
      setVideos([]);
      return;
    }
    setLoadingVideos(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/videos`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setVideos(data.videos);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingVideos(false);
    }
  }, []);

  const handleSync = useCallback(async (channelId?: string) => {
    setSyncing(true);
    setError(null);
    setLastSyncSummary(null);
    try {
      const res = await fetch("/api/channels/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(channelId ? { channelId } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setLastSyncSummary(
        `Synced "${data.channel.title}" — ${data.videoCount} video${data.videoCount === 1 ? "" : "s"}`
      );
      setChannels([data.channel]);
      setSelectedChannelId(data.channel.channelId);
      await fetchVideos(data.channel.channelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }, [fetchVideos]);

  // Only one channel is ever active (docs/decisions/0004-active-channel-read-scoping.md), so
  // there is nothing for the operator to pick -- resolve it implicitly and, per the staleness
  // policy above, either show the cached local list instantly or resync in the background.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingChannels(true);
      try {
        const res = await fetch("/api/channels");
        const data = await res.json();
        if (cancelled || !res.ok || !Array.isArray(data.channels)) return;
        const activeChannels = data.channels as SyncedChannel[];
        setChannels(activeChannels);
        const active = activeChannels[0];
        if (!active) return;
        setSelectedChannelId(active.channelId);

        const lastSyncedMs = active.lastSyncedAt ? new Date(active.lastSyncedAt).getTime() : 0;
        const isStale = Date.now() - lastSyncedMs > AUTO_RESYNC_STALENESS_MS;
        if (isStale) {
          await handleSync(active.channelId);
        } else {
          await fetchVideos(active.channelId);
        }
      } finally {
        if (!cancelled) setLoadingChannels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally mount-only: a tab switch already remounts this component (see the comment
    // above AUTO_RESYNC_STALENESS_MS), so re-running this on every fetchVideos/handleSync
    // identity change would defeat the whole "decide once per mount" point of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-3">
          {loadingChannels ? (
            <p className="text-sm text-zinc-400">Loading...</p>
          ) : !selectedChannelId ? (
            <p className="text-sm text-zinc-400">
              No channel synchronized yet — sign in and this app will pick up your active channel
              automatically.
            </p>
          ) : null}

          {selectedChannelId && (
            <button
              onClick={() => handleSync(selectedChannelId)}
              disabled={syncing}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          )}
        </div>

        {selectedChannelId && (
          <p className="text-xs text-zinc-500">
            Last synced:{" "}
            {channels.find((c) => c.channelId === selectedChannelId)?.lastSyncedAt
              ? new Date(
                  channels.find((c) => c.channelId === selectedChannelId)!.lastSyncedAt!
                ).toLocaleString()
              : "never"}
          </p>
        )}

        {lastSyncSummary && (
          <p className="text-sm font-medium text-green-500">{lastSyncSummary}</p>
        )}

        {error && (
          <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
            {error}
          </div>
        )}
      </div>

      {selectedChannelId && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <span className="text-sm font-medium text-zinc-400">
              {loadingVideos
                ? "Loading synchronized videos..."
                : `${videos.length} synchronized video${videos.length === 1 ? "" : "s"}`}
            </span>
          </div>

          <div className="max-h-[600px] overflow-y-auto">
            {videos.map((video) => (
              <div
                key={video.videoId}
                className="flex items-start gap-3 border-b border-zinc-800/50 px-4 py-3 last:border-b-0"
              >
                {video.thumbnails.default?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={video.thumbnails.default.url}
                    alt={video.title}
                    className="h-12 w-16 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{video.title}</p>
                  <p className="text-xs text-zinc-500">
                    {video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : "—"} ·{" "}
                    {video.privacyStatus} · default: {video.defaultLanguage ?? "unset"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {video.existingLocalizationLanguages.length === 0 ? (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500">
                        No localizations
                      </span>
                    ) : (
                      video.existingLocalizationLanguages.map((lang) => (
                        <span
                          key={lang}
                          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300"
                        >
                          {lang}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ))}

            {!loadingVideos && videos.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">
                No videos synchronized yet. Click &ldquo;Sync my channel&rdquo; above.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
