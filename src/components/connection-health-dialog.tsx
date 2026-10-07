"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { BlockingDialog } from "./blocking-dialog";
import { useT } from "./ui-text-provider";
import type { Translate } from "@/lib/ui-text";
import type { ConnectionHealth } from "@/lib/channel-connections/contracts";
import { planReloginPrompt } from "@/lib/channel-connections/relogin-prompt";

function describe(t: Translate, row: ConnectionHealth): string {
  if (row.kind === "cloud") {
    if (row.state === "reauth_required") return t("relogin.cloud.expired");
    if (row.daysLeft === null) return t("relogin.cloud.expiresSoon");
    return row.daysLeft <= 1 ? t("relogin.cloud.expiresWithinDay") : t("relogin.cloud.expiresInDays", { count: row.daysLeft });
  }
  if (row.state === "reauth_required") return t("relogin.google.expired");
  if (row.daysLeft === null) return t("relogin.google.expiresSoon");
  return row.daysLeft <= 1 ? t("relogin.google.expiresWithinDay") : t("relogin.google.expiresInDays", { count: row.daysLeft });
}

/**
 * BL-115 -- the dashboard-load popup (shared dim + blur shell). ONE list of every account that needs a new Google
 * login; the user chooses which to sign in first (that account becomes the active session, the others stay listed
 * until they are done). Cannot be dismissed while any account is `reauth_required`; for accounts that only expire
 * soon there is a "Later" button.
 */
export function ConnectionHealthDialog({ health }: { health: ConnectionHealth[] | null }) {
  const t = useT();
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
  // A dismissable dialog can still list a grant that is already dead (a lone Google Cloud grant never blocks).
  const anyExpired = prompt.rows.some((row) => row.state === "reauth_required");

  return (
    <BlockingDialog label={t("relogin.title")} maxWidthClass="max-w-md">
      <p className="text-sm font-medium text-zinc-100">{blocking || anyExpired ? t("relogin.title") : t("relogin.titleExpiring")}</p>
      <p className="text-xs text-zinc-400">
        {blocking ? t("relogin.bodyBlocking") : anyExpired ? t("relogin.bodyExpired") : t("relogin.bodyExpiring")}
      </p>
      <ul className="space-y-2">
        {prompt.rows.map((row) => (
          <li key={row.channelId} className="flex items-center gap-3 rounded-md border border-zinc-800 p-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-100">{row.title}</p>
              <p className="truncate text-xs text-zinc-500">{row.connectedEmail}</p>
              <p className={`text-xs ${row.state === "reauth_required" ? "text-red-400" : "text-amber-400"}`}>{describe(t, row)}</p>
            </div>
            <button
              onClick={() => {
                // The Cloud grant has its own consent flow (a full-page redirect), separate from the channel sign-in.
                if (row.kind === "cloud") window.location.href = "/api/cloud-connection/start";
                else void signIn("google", undefined, { login_hint: row.connectedEmail });
              }}
              className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              {row.kind === "cloud" ? t("relogin.reconnectCloud") : t("signIn.google")}
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
            {t("common.later")}
          </button>
        </div>
      )}
    </BlockingDialog>
  );
}
