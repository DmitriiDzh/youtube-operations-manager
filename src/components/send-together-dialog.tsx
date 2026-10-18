"use client";

import { errorText } from "@/lib/ui-text";
import { useEffect, useState } from "react";
import { BlockingDialog } from "./blocking-dialog";
import { useUiText } from "./ui-text-provider";

type ConflictOption = {
  changeSetId: string;
  changes: Array<{ changeId: string; field: string; changeType: string; proposedValue: string }>;
};
type Conflict = { videoId: string; videoTitle: string | null; language: string; options: ConflictOption[] };
type Plan = {
  videoCount: number;
  changeCount: number;
  languageCount: number;
  estimatedUnits: number;
  conflicts: Conflict[];
  inFlightBatchId: string | null;
  inFlightCoversSelection: boolean;
};
export type MergeResolution = { videoId: string; language: string; changeSetId: string };

const unitKey = (videoId: string, language: string) => `${videoId}\u0000${language.toLowerCase()}`;

/**
 * BL-198 (docs/roadmap/plans/SEND_TOGETHER_PLAN.md): before several change sets are sent as one batch, shows what it will write
 * (videos, changes, languages, estimated quota) and, where two sets change the same field of a video's language, lets the owner
 * pick which set's variant goes in. The variant not picked is rejected in its set on a live send (it can be approved again).
 * Nothing is created here: `onConfirm` hands the choices to the caller, which creates the batch.
 */
export function SendTogetherDialog({
  channelId,
  changeSetIds,
  setLabel,
  allowDryRun,
  onConfirm,
  onClose,
}: {
  channelId: string;
  changeSetIds: string[];
  /** A readable name for a change set (its source and date). */
  setLabel: (changeSetId: string) => string;
  /** The Batches tab offers a dry run; the Languages tab sends live. */
  allowDryRun?: boolean;
  onConfirm: (input: { resolutions: MergeResolution[]; dryRun: boolean }) => void;
  onClose: () => void;
}) {
  const { t, formatNumber } = useUiText();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState(allowDryRun === true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/channels/${encodeURIComponent(channelId)}/change-sets/send-together/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changeSetIds }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) setError(errorText(t, body, t("sendTogether.planFailed"), { showErrorField: false }));
        else setPlan(body as Plan);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : t("sendTogether.planFailed")));
    return () => {
      cancelled = true;
    };
  }, [channelId, changeSetIds, t]);

  const unresolved = plan ? plan.conflicts.filter((conflict) => !choices[unitKey(conflict.videoId, conflict.language)]).length : 0;
  const blockedByPending = plan !== null && plan.inFlightBatchId !== null && !plan.inFlightCoversSelection;
  const canConfirm = plan !== null && plan.changeCount > 0 && unresolved === 0 && !blockedByPending;

  function confirm() {
    if (!plan) return;
    const resolutions = plan.conflicts.map((conflict) => ({
      videoId: conflict.videoId,
      language: conflict.language,
      changeSetId: choices[unitKey(conflict.videoId, conflict.language)],
    }));
    onConfirm({ resolutions, dryRun: allowDryRun ? dryRun : false });
  }

  function describeChange(change: ConflictOption["changes"][number]): string {
    if (change.changeType === "delete") return t("sendTogether.conflict.delete");
    return t(change.field === "description" ? "sendTogether.conflict.description" : "sendTogether.conflict.title", { value: change.proposedValue });
  }

  return (
    <BlockingDialog label={t("sendTogether.label")} maxWidthClass="max-w-2xl" busy={plan === null && error === null}>
      <p className="text-sm font-medium text-zinc-100">{t("sendTogether.title", { count: changeSetIds.length })}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!plan && !error && <p className="text-xs text-zinc-400">{t("sendTogether.loading")}</p>}
      {plan && plan.changeCount === 0 && <p className="text-xs text-zinc-400">{t("sendTogether.nothing")}</p>}
      {plan && plan.changeCount > 0 && (
        <p className="text-xs text-zinc-300">
          {t("sendTogether.summary", {
            videos: plan.videoCount,
            changes: plan.changeCount,
            languages: plan.languageCount,
            units: formatNumber(plan.estimatedUnits),
          })}
        </p>
      )}
      {blockedByPending && <p className="text-xs text-amber-300">{t("sendTogether.finishPendingFirst")}</p>}
      {plan && plan.conflicts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-amber-300">{t("sendTogether.conflicts.intro", { count: plan.conflicts.length })}</p>
          <p className="text-xs text-zinc-400">{t("sendTogether.conflicts.rejectNote")}</p>
          <ul className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {plan.conflicts.map((conflict) => {
              const key = unitKey(conflict.videoId, conflict.language);
              return (
                <li key={key} className="rounded-md border border-zinc-800 bg-zinc-950 p-2">
                  <p className="text-xs font-medium text-zinc-200">
                    {t("sendTogether.conflict.unit", { video: conflict.videoTitle ?? conflict.videoId, language: conflict.language })}
                  </p>
                  <div className="mt-1 space-y-1">
                    {conflict.options.map((option) => (
                      <label key={option.changeSetId} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs text-zinc-300 hover:bg-zinc-900">
                        <input
                          type="radio"
                          name={key}
                          checked={choices[key] === option.changeSetId}
                          onChange={() => setChoices((prev) => ({ ...prev, [key]: option.changeSetId }))}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-zinc-400">{setLabel(option.changeSetId)}</span>
                          {option.changes.map((change) => (
                            <span key={change.changeId} className="block break-words">
                              {describeChange(change)}
                            </span>
                          ))}
                        </span>
                      </label>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
          {unresolved > 0 && <p className="text-xs text-zinc-500">{t("sendTogether.conflicts.left", { count: unresolved })}</p>}
        </div>
      )}
      {allowDryRun && plan && plan.changeCount > 0 && (
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          {t("sendTogether.dryRun")}
        </label>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          {t("common.cancel")}
        </button>
        <button
          onClick={confirm}
          disabled={!canConfirm}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
        >
          {allowDryRun ? t(dryRun ? "sendTogether.createDryRun" : "sendTogether.createLive") : t("sendTogether.send")}
        </button>
      </div>
    </BlockingDialog>
  );
}
