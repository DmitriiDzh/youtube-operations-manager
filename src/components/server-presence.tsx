"use client";

import { useEffect, useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import {
  INITIAL_PRESENCE_STATE,
  nextPresenceState,
  PRESENCE_PING_INTERVAL_MS,
  type PresenceState,
} from "@/lib/server-presence/heartbeat";

/**
 * BL-116 -- the open page's heartbeat. While any window with the app is open it pings `/api/presence` every minute
 * (and at once when the tab becomes visible again or the network returns): that is how the local server knows it is
 * still needed and may shut itself down 10 minutes after the last window is gone. If the pings stop being answered the
 * server is gone (shut down after a long absence, a sleeping computer, a closed launcher), and this says so, instead of
 * leaving a page that silently fails.
 */
export function ServerPresence() {
  const [state, setState] = useState<PresenceState>(INITIAL_PRESENCE_STATE);

  useEffect(() => {
    let cancelled = false;

    async function ping() {
      let ok = false;
      try {
        const res = await fetch("/api/presence", { cache: "no-store" });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (!cancelled) setState((previous) => nextPresenceState(previous, ok));
    }

    void ping();
    const timer = setInterval(() => void ping(), PRESENCE_PING_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void ping();
    };
    const onOnline = () => void ping();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  if (!state.serverStopped) return null;

  return (
    <BlockingDialog label="The server has stopped" maxWidthClass="max-w-md">
      <p className="text-sm font-medium text-zinc-100">The server has stopped</p>
      <p className="text-xs text-zinc-400">
        The application server is no longer running. It shuts itself down after 10 minutes without an open window, or
        when the computer sleeps or the launcher is closed. Open the application shortcut again to start it, then press
        Retry.
      </p>
      <div className="flex justify-end">
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        >
          Retry
        </button>
      </div>
    </BlockingDialog>
  );
}
