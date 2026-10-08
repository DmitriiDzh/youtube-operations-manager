"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { SendApprovedButton } from "./send-approved-button";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type Change = {
  id: string;
  videoId: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  changeType: "add" | "modify" | "unchanged" | "delete";
  validationStatus: "valid" | "invalid";
  validationError: string | null;
  conflictStatus: "none" | "conflict";
  approvalStatus: "pending" | "approved" | "rejected";
};

type ChangeSet = {
  id: string;
  channelId: string;
  status: "in_review" | "approved" | "partially_approved" | "rejected";
  source: "xlsx_import" | "ai_localization" | "deletion";
  importedFilename: string | null;
  totalChanges: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  conflictCount: number;
  invalidCount: number;
  createdAt: string;
};

type StatusFilter = "all" | "pending" | "approved" | "rejected" | "conflict" | "invalid";

const CHANGE_TYPE_LABELS: Record<Change["changeType"], UiTextKey> = {
  add: "changeSet.changeType.add",
  modify: "changeSet.changeType.modify",
  unchanged: "changeSet.changeType.unchanged",
  delete: "changeSet.changeType.delete",
};

const APPROVAL_LABELS: Record<Change["approvalStatus"], UiTextKey> = {
  pending: "changeSet.approval.pending",
  approved: "changeSet.approval.approved",
  rejected: "changeSet.approval.rejected",
};

/** Shared with the Languages tab's change-set queue, which shows the same status badge. */
export const CHANGE_SET_STATUS_LABELS: Record<ChangeSet["status"], UiTextKey> = {
  in_review: "changeSet.status.in_review",
  approved: "changeSet.status.approved",
  partially_approved: "changeSet.status.partially_approved",
  rejected: "changeSet.status.rejected",
};

/** Where a change set came from, when it has no imported file name. Shared with the Languages tab's queue. */
export const CHANGE_SET_SOURCE_LABELS: Record<ChangeSet["source"], UiTextKey> = {
  ai_localization: "changeSet.source.ai",
  deletion: "changeSet.source.deletion",
  xlsx_import: "changeSet.source.xlsx",
};

function fieldLabel(t: Translate, field: Change["field"]) {
  return field === "title" ? t("changeSet.field.title") : t("changeSet.field.description");
}

function changeTypeBadge(t: Translate, type: Change["changeType"]) {
  const styles: Record<Change["changeType"], string> = {
    add: "bg-green-900/40 text-green-400",
    modify: "bg-blue-900/40 text-blue-400",
    unchanged: "bg-zinc-800 text-zinc-500",
    delete: "bg-red-900/40 text-red-300",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${styles[type]}`}>{t(CHANGE_TYPE_LABELS[type])}</span>;
}

export function ChangeSetReview({
  channelId,
  changeSetId,
  onClose,
  onStatusChange,
  onWritten,
}: {
  channelId: string;
  changeSetId: string;
  onClose: () => void;
  /** Called after an approve/reject action actually changes this change set's status, so a
   * parent showing a stale summary (e.g. status-based sub-tab filtering) can refresh it. Not
   * called on the initial load. */
  onStatusChange?: () => void;
  /** Called when a send to YouTube has finished, so the parent can reload what it shows from the local copy (which the write has just updated). */
  onWritten?: () => void;
}) {
  const t = useT();
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [languageFilter, setLanguageFilter] = useState("");
  const [videoFilter, setVideoFilter] = useState("");
  const [busyChangeId, setBusyChangeId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (languageFilter.trim()) params.set("language", languageFilter.trim());
      if (videoFilter.trim()) params.set("videoId", videoFilter.trim());
      params.set("pageSize", "100");

      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}?${params.toString()}`
      );
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      setChangeSet(data.changeSet);
      setChanges(data.changes);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [channelId, changeSetId, statusFilter, languageFilter, videoFilter, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(changeId: string, action: "approve" | "reject") {
    setBusyChangeId(changeId);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}/changes/${encodeURIComponent(changeId)}/${action}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      await load();
      onStatusChange?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyChangeId(null);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setConfirmDelete(false);
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      setConfirmDelete(false);
      onStatusChange?.();
      onClose();
    } catch (e) {
      setConfirmDelete(false);
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function handleBulk(action: "approve-all" | "reject-all") {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/channels/${encodeURIComponent(channelId)}/change-sets/${encodeURIComponent(changeSetId)}/${action}`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: res.status })));
        return;
      }
      await load();
      onStatusChange?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t("changeSet.review.title")}</h3>
          {changeSet && (
            <p className="text-xs text-zinc-500">
              {t("changeSet.review.subtitle", {
                source: changeSet.importedFilename ?? t(CHANGE_SET_SOURCE_LABELS[changeSet.source]),
                count: changeSet.totalChanges,
                status: t(CHANGE_SET_STATUS_LABELS[changeSet.status]),
              })}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={deleting || bulkBusy || busyChangeId !== null}
            className="rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:border-red-700 hover:text-red-300 disabled:opacity-50"
          >
            {t("changeSet.review.deleteSet")}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
          >
            {t("common.close")}
          </button>
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t("changeSet.review.deleteTitle")}
          description={t("changeSet.review.deleteDescription")}
          confirmLabel={deleting ? t("changeSet.review.deleting") : t("changeSet.review.delete")}
          confirmVariant="danger"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void handleDelete()}
        />
      )}

      {changeSet && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-300">{t("changeSet.review.total", { count: changeSet.totalChanges })}</span>
          <span className="rounded bg-amber-900/40 px-2 py-1 text-amber-400">{t("changeSet.review.pending", { count: changeSet.pendingCount })}</span>
          <span className="rounded bg-green-900/40 px-2 py-1 text-green-400">{t("changeSet.review.approved", { count: changeSet.approvedCount })}</span>
          <span className="rounded bg-zinc-800 px-2 py-1 text-zinc-400">{t("changeSet.review.rejected", { count: changeSet.rejectedCount })}</span>
          <span className="rounded bg-red-900/40 px-2 py-1 text-red-400">{t("changeSet.review.conflicts", { count: changeSet.conflictCount })}</span>
          <span className="rounded bg-red-900/40 px-2 py-1 text-red-400">{t("changeSet.review.invalid", { count: changeSet.invalidCount })}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs"
        >
          <option value="all">{t("changeSet.filter.all")}</option>
          <option value="pending">{t("changeSet.filter.pending")}</option>
          <option value="approved">{t("changeSet.filter.approved")}</option>
          <option value="rejected">{t("changeSet.filter.rejected")}</option>
          <option value="conflict">{t("changeSet.filter.conflict")}</option>
          <option value="invalid">{t("changeSet.filter.invalid")}</option>
        </select>
        <input
          value={languageFilter}
          onChange={(e) => setLanguageFilter(e.target.value)}
          placeholder={t("changeSet.filter.languagePlaceholder")}
          className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs placeholder:text-zinc-600"
        />
        <input
          value={videoFilter}
          onChange={(e) => setVideoFilter(e.target.value)}
          placeholder={t("changeSet.filter.videoPlaceholder")}
          className="w-32 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs placeholder:text-zinc-600"
        />
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => handleBulk("approve-all")}
            disabled={bulkBusy}
            className="rounded-lg bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
          >
            {t("changeSet.review.approveAll")}
          </button>
          {changeSet && changeSet.approvedCount > 0 && (
            <SendApprovedButton
              channelId={channelId}
              changeSetId={changeSetId}
              approvedCount={changeSet.approvedCount}
              onFinished={() => {
                void load();
                onStatusChange?.();
                onWritten?.();
              }}
            />
          )}
          <button
            onClick={() => handleBulk("reject-all")}
            disabled={bulkBusy}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            {t("changeSet.review.rejectAll")}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}

      <div className="space-y-2">
        {loading && <LoadingIndicator className="text-sm text-zinc-500" />}
        {!loading && changes.length === 0 && <p className="text-sm text-zinc-500">{t("changeSet.review.noMatch")}</p>}
        {changes.map((change) => (
          <div key={change.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="font-medium text-zinc-300">{change.videoId}</span>
              <span>·</span>
              <span>{change.language}</span>
              <span>·</span>
              <span>{fieldLabel(t, change.field)}</span>
              {changeTypeBadge(t, change.changeType)}
              {change.conflictStatus === "conflict" && (
                <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] uppercase text-red-400">{t("changeSet.review.conflictBadge")}</span>
              )}
              {change.validationStatus === "invalid" && (
                <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-[10px] uppercase text-red-400">{t("changeSet.review.invalidBadge")}</span>
              )}
              <span
                className={`ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase ${
                  change.approvalStatus === "approved"
                    ? "bg-green-900/40 text-green-400"
                    : change.approvalStatus === "rejected"
                      ? "bg-zinc-800 text-zinc-500"
                      : "bg-amber-900/40 text-amber-400"
                }`}
              >
                {t(APPROVAL_LABELS[change.approvalStatus])}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <p className="text-[10px] uppercase text-zinc-600">{t("changeSet.review.current")}</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-400">{change.baselineValue || t("changeSet.review.empty")}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase text-zinc-600">{t("changeSet.review.proposed")}</p>
                <p className="whitespace-pre-wrap text-sm text-zinc-100">{change.proposedValue}</p>
              </div>
            </div>

            {change.validationError && <p className="mt-2 text-xs text-red-400">{change.validationError}</p>}
            {change.conflictStatus === "conflict" && (
              <p className="mt-2 text-xs text-red-400">
                {t("changeSet.review.conflictExplanation")}
              </p>
            )}

            {change.approvalStatus === "pending" && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleAction(change.id, "approve")}
                  disabled={busyChangeId === change.id || change.validationStatus === "invalid" || change.conflictStatus === "conflict"}
                  className="rounded-lg bg-green-700 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-40"
                >
                  {t("changeSet.review.approve")}
                </button>
                <button
                  onClick={() => handleAction(change.id, "reject")}
                  disabled={busyChangeId === change.id}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
                >
                  {t("changeSet.review.reject")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
