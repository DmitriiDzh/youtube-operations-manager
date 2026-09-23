"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { activateStoredChannel, useConnectedChannels } from "./use-connected-channels";

/**
 * Topbar "Switch channel" control (owner instruction, 2026-09-23, following BL-071's Settings
 * "Channels" section: "перерабатываем кнопку Switch Channel, она должна предлагать список из уже
 * подключенных каналов и внизу кнопку добавить новый... максимально использовать тот функционал
 * что уже есть"). Reuses `useConnectedChannels`/`activateStoredChannel` unchanged -- this
 * component adds only the dropdown UI, never a second way to fetch or activate a channel.
 *
 * Previously this button called `signIn("google")` directly, always forcing Google's consent
 * screen even to switch to an already-connected channel -- that path is now reserved for "+
 * Connect a new channel" at the bottom of the list; picking an existing row reactivates it the
 * same way Settings → Channels' "Activate" button does.
 */
export function ChannelSwitcher() {
  const { channels, refetch } = useConnectedChannels();
  const [open, setOpen] = useState(false);
  const [activatingChannelId, setActivatingChannelId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function handleActivate(channelId: string) {
    setActivatingChannelId(channelId);
    try {
      const { ok } = await activateStoredChannel(channelId);
      if (ok) {
        setOpen(false);
        await refetch();
      }
    } finally {
      setActivatingChannelId(null);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="ml-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-white"
      >
        Switch channel
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-2 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
          <ul className="max-h-72 overflow-y-auto p-1">
            {channels === null && (
              <li className="px-3 py-2 text-xs text-zinc-500">Loading...</li>
            )}
            {channels?.length === 0 && (
              <li className="px-3 py-2 text-xs text-zinc-500">No channels connected yet.</li>
            )}
            {channels?.map((c) => (
              <li key={c.channelId}>
                <button
                  onClick={() => handleActivate(c.channelId)}
                  disabled={c.isActive || activatingChannelId === c.channelId}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  {c.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnailUrl} alt="" className="h-6 w-6 shrink-0 rounded-full" />
                  ) : (
                    <div className="h-6 w-6 shrink-0 rounded-full bg-zinc-700" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.isActive ? (
                    <span className="shrink-0 text-[10px] font-medium text-emerald-400">Active</span>
                  ) : activatingChannelId === c.channelId ? (
                    <span className="shrink-0 text-[10px] text-zinc-500">Activating...</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-zinc-800 p-1">
            <button
              onClick={() => signIn("google")}
              className="w-full rounded-md px-2 py-1.5 text-left text-sm font-medium text-indigo-400 hover:bg-zinc-800"
            >
              + Connect a new channel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
