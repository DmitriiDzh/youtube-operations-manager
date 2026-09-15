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

export function ChannelSync() {
  const [channels, setChannels] = useState<SyncedChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [videos, setVideos] = useState<SyncedVideo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    setLoadingChannels(true);
    try {
      const res = await fetch("/api/channels");
      const data = await res.json();
      if (res.ok && Array.isArray(data.channels)) {
        setChannels(data.channels);
        return data.channels as SyncedChannel[];
      }
      return [];
    } finally {
      setLoadingChannels(false);
    }
  }, []);

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

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  useEffect(() => {
    if (selectedChannelId) {
      fetchVideos(selectedChannelId);
    }
  }, [selectedChannelId, fetchVideos]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setLastSyncSummary(null);
    try {
      const res = await fetch("/api/channels/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedChannelId ? { channelId: selectedChannelId } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setLastSyncSummary(
        `Synced "${data.channel.title}" — ${data.videoCount} video${data.videoCount === 1 ? "" : "s"}`
      );
      await fetchChannels();
      setSelectedChannelId(data.channel.channelId);
      await fetchVideos(data.channel.channelId);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-medium text-zinc-400">Channel</label>
          <select
            value={selectedChannelId}
            onChange={(e) => setSelectedChannelId(e.target.value)}
            disabled={loadingChannels}
            className="min-w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="">
              {loadingChannels
                ? "Loading channels..."
                : channels.length > 0
                  ? "Select a synchronized channel..."
                  : "No channels synchronized yet"}
            </option>
            {channels.map((c) => (
              <option key={c.channelId} value={c.channelId}>
                {c.title}
              </option>
            ))}
          </select>

          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {syncing
              ? "Syncing..."
              : selectedChannelId
                ? "Re-sync this channel"
                : "Sync my channel"}
          </button>
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
