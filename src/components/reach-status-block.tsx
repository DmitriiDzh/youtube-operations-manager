"use client";

import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { useT } from "./ui-text-provider";
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
  ok: { textKey: "reach.status.outcome.ok", className: "text-emerald-400" },
  partial: { textKey: "reach.status.outcome.partial", className: "text-amber-400" },
  failed: { textKey: "reach.status.outcome.failed", className: "text-red-400" },
} as const;

/**
 * BL-114 -- what the Analytics card shows about the Reporting job and its files (owner instruction, 2026-10-03:
 * the status of the requests lives in the Analytics tab; Settings only shows the quota). Everything is local
 * data from `GET /api/channels/{id}/reach/status`; "not known" is said as such, never shown as zero.
 */
export function ReachStatusBlock({ status }: { status: ReachStatusData }) {
  const t = useT();
  const { job, lastAttempt } = status;
  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">
      <div className="mb-2 font-medium text-zinc-300">{t("reach.status.title")}</div>

      {!status.readsEnabled && (
        <p className="mb-2 text-amber-400">{t("reach.status.readsOff")}</p>
      )}
      {status.firstFileOverdue && (
        <p className="mb-2 text-amber-400">
          {status.firstFileExpectedBy
            ? t("reach.status.overdue", { date: fmt(status.firstFileExpectedBy) })
            : t("reach.status.overdueNoDate")}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-zinc-500">{t("reach.status.subscription")}</dt>
        <dd>
          {job ? (
            <>
              <span className="font-mono">{job.jobId}</span>
              {job.createdAt ? t("reach.status.createdAt", { date: fmt(job.createdAt) }) : ""}
            </>
          ) : (
            t("reach.status.notCreated")
          )}
        </dd>

        {job && status.importedFiles === 0 && status.firstFileExpectedBy && (
          <>
            <dt className="text-zinc-500">{t("reach.status.firstFileExpected")}</dt>
            <dd>{t("reach.status.firstFileBy", { date: fmt(status.firstFileExpectedBy) })}</dd>
          </>
        )}

        <dt className="text-zinc-500">{t("reach.status.lastSync")}</dt>
        <dd>
          {lastAttempt ? (
            <>
              {fmt(lastAttempt.at)} &mdash;{" "}
              <span className={OUTCOME_LABEL[lastAttempt.outcome].className}>{t(OUTCOME_LABEL[lastAttempt.outcome].textKey)}</span>
              {lastAttempt.outcome !== "failed" &&
                t("reach.status.runFiles", { listed: lastAttempt.filesListed, imported: lastAttempt.filesImported })}
            </>
          ) : (
            t("reach.status.noSync")
          )}
        </dd>

        {lastAttempt?.error && (
          <>
            <dt className="text-zinc-500">{t("reach.status.error")}</dt>
            <dd className="break-words text-red-400">{lastAttempt.error}</dd>
          </>
        )}

        <dt className="text-zinc-500">{t("reach.status.nextCheck")}</dt>
        <dd>
          {status.nextAutoCheckAt
            ? t("reach.status.nextCheckAt", { date: fmt(status.nextAutoCheckAt) })
            : t("reach.status.nextCheckOnOpen")}
        </dd>

        <dt className="text-zinc-500">{t("reach.status.importedFiles")}</dt>
        <dd>{status.importedFiles}</dd>
      </dl>

      {lastAttempt && lastAttempt.failures.length > 0 && (
        <div className="mt-2">
          <div className="text-zinc-500">{t("reach.status.failedFiles")}</div>
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
          <summary className="cursor-pointer text-zinc-300">{t("reach.status.reportFiles", { count: status.files.length })}</summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-0.5 font-medium">{t("reach.status.column.day")}</th>
                <th className="py-0.5 text-right font-medium">{t("reach.status.column.rows")}</th>
                <th className="py-0.5 font-medium pl-3">{t("reach.status.column.status")}</th>
                <th className="py-0.5 font-medium">{t("reach.status.column.imported")}</th>
              </tr>
            </thead>
            <tbody>
              {status.files.map((f) => (
                <tr key={f.reportId} className="border-t border-zinc-800 text-zinc-300">
                  <td className="py-0.5">{day(f.startTime)}</td>
                  <td className="py-0.5 text-right">{f.rowCount}</td>
                  <td className="py-0.5 pl-3">{f.status === "superseded" ? t("reach.status.superseded") : f.status}</td>
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
