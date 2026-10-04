"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { BlockingDialog } from "./blocking-dialog";
import type { ConnectionHealth } from "@/lib/channel-connections/contracts";
import { planReloginPrompt } from "@/lib/channel-connections/relogin-prompt";

function describe(row: ConnectionHealth): string {
  if (row.kind === "cloud") {
    if (row.state === "reauth_required") return "Google Cloud connection expired — the quota numbers are hidden until you reconnect.";
    if (row.daysLeft === null) return "Google Cloud connection expires soon.";
    return row.daysLeft <= 1 ? "Google Cloud connection expires within a day." : `Google Cloud connection expires in about ${row.daysLeft} days.`;
  }
  if (row.state === "reauth_required") return "Google sign-in expired — sign in again to keep using this channel.";
  if (row.daysLeft === null) return "Google sign-in expires soon.";
  return row.daysLeft <= 1 ? "Google sign-in expires within a day." : `Google sign-in expires in about ${row.daysLeft} days.`;
}

/**
 * BL-115 -- the dashboard-load popup (shared dim + blur shell). ONE list of every account that needs a new Google
 * login; the user chooses which to sign in first (that account becomes the active session, the others stay listed
 * until they are done). Cannot be dismissed while any account is `reauth_required`; for accounts that only expire
 * soon there is a "Later" button.
 */
export function ConnectionHealthDialog({ health }: { health: ConnectionHealth[] | null }) {
  const [later, setLater] = useState(false);
  const prompt = planReloginPrompt(health ?? [], later);
  const blocking = prompt.mode === "blocking";

  // Capture phase: a window-level Escape handler underneath (e.g. a modal) must not close things behind a blocking prompt.
  useEffect(() => {
    if (!blocking) return;
    const swallow = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [blocking]);

  if (prompt.mode === "none") return null;

  return (
    <BlockingDialog label="Sign in with Google again" maxWidthClass="max-w-md">
      <p className="text-sm font-medium text-zinc-100">
        {blocking ? "Sign in with Google again" : "A Google sign-in is about to expire"}
      </p>
      <p className="text-xs text-zinc-400">
        {blocking
          ? "Google no longer accepts the saved sign-in for the account(s) below. Choose the account to sign in with first."
          : "Sign in again before it expires to avoid an interruption."}
      </p>
      <ul className="space-y-2">
        {prompt.rows.map((row) => (
          <li key={row.channelId} className="flex items-center gap-3 rounded-md border border-zinc-800 p-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-100">{row.title}</p>
              <p className="truncate text-xs text-zinc-500">{row.connectedEmail}</p>
              <p className={`text-xs ${row.state === "reauth_required" ? "text-red-400" : "text-amber-400"}`}>{describe(row)}</p>
            </div>
            <button
              onClick={() => {
                // The Cloud grant has its own consent flow (a full-page redirect), separate from the channel sign-in.
                if (row.kind === "cloud") window.location.href = "/api/cloud-connection/start";
                else void signIn("google", undefined, { login_hint: row.connectedEmail });
              }}
              className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              {row.kind === "cloud" ? "Reconnect Google Cloud" : "Sign in with Google"}
            </button>
          </li>
        ))}
      </ul>
      {!blocking && (
        <div className="flex justify-end">
          <button
            onClick={() => setLater(true)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800"
          >
            Later
          </button>
        </div>
      )}
    </BlockingDialog>
  );
}
