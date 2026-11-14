"use client";

import { signIn, useSession } from "next-auth/react";
import { redirect } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { isRemoteHost } from "@/components/remote-host";
import { useT } from "@/components/ui-text-provider";
import type { UiTextKey } from "@/lib/ui-text";

// BL-251: the error codes the password sign-in returns (src/lib/auth.ts `remote-password`) and what the page says for them.
const REMOTE_ERRORS: Record<string, UiTextKey> = {
  remote_access_bad_password: "remoteAccess.login.wrong",
  remote_access_locked: "remoteAccess.login.locked",
  remote_access_disabled: "remoteAccess.login.disabled",
  no_connected_channel: "remoteAccess.login.noChannel",
  CredentialsSignin: "remoteAccess.login.wrong",
};

const noSubscribe = () => () => undefined;

/** BL-251: on another device (through tailscale serve) the owner signs in with the password set on the Mac. */
function RemotePasswordLogin() {
  const t = useT();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // redirect: false -- NEXTAUTH_URL is this Mac's localhost; the page moves on by itself.
    const result = await signIn("remote-password", { password, redirect: false });
    setBusy(false);
    if (result?.ok && !result.error) {
      window.location.href = "/home";
      return;
    }
    setError(t(REMOTE_ERRORS[result?.error ?? ""] ?? "remoteAccess.login.failed"));
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
      <h2 className="text-center text-lg font-medium text-zinc-200">{t("remoteAccess.login.title")}</h2>
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        aria-label={t("remoteAccess.login.password")}
        placeholder={t("remoteAccess.login.password")}
        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-base text-zinc-100"
      />
      <button type="submit" disabled={busy || password.length === 0} className="rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-900 disabled:opacity-50">
        {t("remoteAccess.login.submit")}
      </button>
      {error && <p className="text-center text-sm text-red-400">{error}</p>}
    </form>
  );
}

export default function Home() {
  const { data: session, status } = useSession();
  const t = useT();
  // BL-251: false on the server render, the real answer in the browser (no hydration mismatch, no effect).
  const remote = useSyncExternalStore(noSubscribe, isRemoteHost, () => false);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-zinc-500">{t("common.loading")}</p>
      </div>
    );
  }

  if (session) {
    redirect("/home");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          {/* ui-text-ignore: the product name */}
          YouTube Operations Manager
        </h1>
        <p className="mt-3 text-lg text-zinc-400">
          {t("app.description")}
        </p>
      </div>

      {remote ? <RemotePasswordLogin /> : <button
        onClick={() => signIn("google")}
        className="flex items-center gap-3 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-900 shadow-sm transition-colors hover:bg-zinc-100"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        {t("signIn.google")}
      </button>}
    </div>
  );
}
