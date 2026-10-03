"use client";

import { formatDisplayDateTime } from "@/lib/shared-formatting";
export type ReachStatusData = {
  job: { jobId: string; createdAt: string | null } | null;
  firstFileExpectedBy: string | null;
  firstFileOverdue: boolean;
  lastAttempt: {
    at: string;
    outcome: "ok" | "partial" | "failed";
    error: string | null;
    filesListed: number;
    filesImported: number;
    failures: Array<{ reportId: string; error: string }>;
  } | null;
  nextAutoCheckAt: string | null;
  importedFiles: number;
  files: Array<{
    reportId: string;
    startTime: string;
    endTime: string;
    createTime: string;
    rowCount: number;
    status: string;
    importedAt: string;
  }>;
  /** Whether the Settings "Reporting reads" toggle is on; when off no sync can run. */
  readsEnabled: boolean;
};

const fmt = (iso: string) => formatDisplayDateTime(iso);
/** A report file's period is a Pacific-Time reporting day; the day part of its start is its label (never shifted). */
const day = (iso: string) => iso.slice(0, 10);

const OUTCOME_LABEL = {
  ok: { text: "OK", className: "text-emerald-400" },
  partial: { text: "Partly failed (failed files are retried)", className: "text-amber-400" },
  failed: { text: "Failed", className: "text-red-400" },
} as const;

/**
 * BL-114 -- what the Analytics card shows about the Reporting job and its files (owner instruction, 2026-10-03:
 * the status of the requests lives in the Analytics tab; Settings only shows the quota). Everything is local
 * data from `GET /api/channels/{id}/reach/status`; "not known" is said as such, never shown as zero.
 */
export function ReachStatusBlock({ status }: { status: ReachStatusData }) {
  const { job, lastAttempt } = status;
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
      <div className="mb-2 font-medium text-zinc-300">Report subscription status</div>

      {!status.readsEnabled && (
        <p className="mb-2 text-amber-400">
          Reporting reads are switched off in Settings &mdash; no sync will run until they are turned on.
        </p>
      )}
      {status.firstFileOverdue && (
        <p className="mb-2 text-amber-400">
          The first file was expected by {status.firstFileExpectedBy ? fmt(status.firstFileExpectedBy) : "48 hours after creation"} and
          has not arrived. This is later than YouTube normally takes &mdash; check the last sync result below.
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-zinc-500">Subscription</dt>
        <dd>
          {job ? (
            <>
              <span className="font-mono">{job.jobId}</span>
              {job.createdAt ? `, created ${fmt(job.createdAt)}` : ""}
            </>
          ) : (
            "not created yet"
          )}
        </dd>

        {job && status.importedFiles === 0 && status.firstFileExpectedBy && (
          <>
            <dt className="text-zinc-500">First file expected</dt>
            <dd>by {fmt(status.firstFileExpectedBy)} (up to 48 hours after creation)</dd>
          </>
        )}

        <dt className="text-zinc-500">Last sync</dt>
        <dd>
          {lastAttempt ? (
            <>
              {fmt(lastAttempt.at)} &mdash;{" "}
              <span className={OUTCOME_LABEL[lastAttempt.outcome].className}>{OUTCOME_LABEL[lastAttempt.outcome].text}</span>
              {lastAttempt.outcome !== "failed" &&
                `; ${lastAttempt.filesListed} file(s) on YouTube, ${lastAttempt.filesImported} imported in that run`}
            </>
          ) : (
            "no sync has run yet"
          )}
        </dd>

        {lastAttempt?.error && (
          <>
            <dt className="text-zinc-500">Error</dt>
            <dd className="break-words text-red-400">{lastAttempt.error}</dd>
          </>
        )}

        <dt className="text-zinc-500">Next automatic check</dt>
        <dd>
          {status.nextAutoCheckAt ? `not before ${fmt(status.nextAutoCheckAt)} (when the dashboard is opened)` : "on the next dashboard open"}
        </dd>

        <dt className="text-zinc-500">Imported files</dt>
        <dd>{status.importedFiles}</dd>
      </dl>

      {lastAttempt && lastAttempt.failures.length > 0 && (
        <div className="mt-2">
          <div className="text-zinc-500">Files that failed in the last sync (retried automatically):</div>
          <ul className="mt-1 space-y-0.5">
            {lastAttempt.failures.map((f) => (
              <li key={f.reportId} className="break-words text-amber-400">
                <span className="font-mono">{f.reportId}</span> &mdash; {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {status.files.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-zinc-300">Report files ({status.files.length})</summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-0.5 font-medium">Day</th>
                <th className="py-0.5 text-right font-medium">Rows</th>
                <th className="py-0.5 font-medium pl-3">Status</th>
                <th className="py-0.5 font-medium">Imported</th>
              </tr>
            </thead>
            <tbody>
              {status.files.map((f) => (
                <tr key={f.reportId} className="border-t border-zinc-800 text-zinc-300">
                  <td className="py-0.5">{day(f.startTime)}</td>
                  <td className="py-0.5 text-right">{f.rowCount}</td>
                  <td className="py-0.5 pl-3">{f.status === "superseded" ? "superseded by a newer file" : f.status}</td>
                  <td className="py-0.5">{fmt(f.importedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
