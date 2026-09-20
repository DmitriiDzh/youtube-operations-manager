"use client";

import { useEffect, useState } from "react";

type BuildInfo = {
  version: string;
  gitCommit: string | null;
  builtAt: string;
  node: string;
};

/**
 * Shows which version/commit this running instance was actually built from -- captured at
 * `npm run build`/`npm run dev` time by scripts/write-build-info.mjs into public/build-info.json,
 * not read live from git at request time (the two can genuinely differ, e.g. a `git pull`
 * succeeded but the rebuild step failed or was skipped -- the exact ambiguity that prompted
 * this, see scripts/{macos,windows}/start.{sh,bat}'s auto-update step).
 */
export function AppVersionInfo() {
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/build-info.json", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json() as Promise<BuildInfo>;
      })
      .then((data) => {
        if (!cancelled) setBuildInfo(data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load build-info.json");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mb-6 rounded-md border border-border bg-surface px-4 py-3 text-sm">
      <div className="mb-1 font-medium text-white">App version</div>
      {error && <p className="text-muted">{error}</p>}
      {!buildInfo && !error && <p className="text-muted">Loading...</p>}
      {buildInfo && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-muted">
          <dt>Version</dt>
          <dd>{buildInfo.version}</dd>
          <dt>Commit</dt>
          <dd>{buildInfo.gitCommit ? buildInfo.gitCommit.slice(0, 12) : "unknown"}</dd>
          <dt>Built</dt>
          <dd>{new Date(buildInfo.builtAt).toLocaleString()}</dd>
        </dl>
      )}
    </div>
  );
}
