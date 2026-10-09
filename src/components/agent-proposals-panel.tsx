"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, type Translate, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDate, formatDisplayDateTime } from "@/lib/shared-formatting";
import { InfoTooltip } from "./info-tooltip";
import { describeProposalAction, parseApplyError, sortDecided, systemInactiveFacts, type OwnerProposalView } from "./agent-proposals-model";
import { useT } from "./ui-text-provider";

const STATUS_LABELS: Record<OwnerProposalView["status"], UiTextKey> = {
  pending: "agentProposals.status.pending",
  applied: "agentProposals.status.applied",
  rejected: "agentProposals.status.rejected",
  failed: "agentProposals.status.failed",
};

const STATUS_TONE: Record<OwnerProposalView["status"], string> = {
  pending: "bg-amber-500/15 text-amber-300",
  applied: "bg-emerald-500/15 text-emerald-300",
  rejected: "bg-zinc-700/60 text-zinc-300",
  failed: "bg-rose-500/15 text-rose-300",
};

/** Codes after which the card is out of date (decided elsewhere, or its entry is gone): the list is reloaded. */
const STALE_CODES = new Set(["AGENT_PROPOSAL_NOT_PENDING", "AGENT_PROPOSAL_NOT_FOUND"]);

/** The change in plain words, as one line of text (the failure notice quotes it). */
function actionLine(t: Translate, proposal: OwnerProposalView): string {
  const action = describeProposalAction(proposal);
  return action.subject ? `${t(action.key, action.values)}: ${action.subject}` : t(action.key, action.values);
}

/** An apply error in the owner's language when it carries a known code. */
function applyErrorText(t: Translate, applyError: string): string {
  const parsed = parseApplyError(applyError);
  return parsed.error ? errorText(t, parsed, parsed.message, { showErrorField: false }) : parsed.message;
}

/** Who proposed it, for which of our channels, and when -- the card's first line. */
function ProposalMeta({ proposal }: { proposal: OwnerProposalView }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 font-medium ${proposal.source === "producer" ? "bg-violet-500/15 text-violet-300" : "bg-zinc-700/60 text-zinc-300"}`}>
        {t(proposal.source === "producer" ? "agentProposals.source.producer" : "agentProposals.source.system")}
      </span>
      <span className="text-zinc-400">{proposal.channelId ? (proposal.channelTitle ?? proposal.channelId) : t("agentProposals.allChannels")}</span>
      <span className="text-zinc-600">{formatDisplayDateTime(proposal.createdAt)}</span>
    </div>
  );
}

/** The change approving it makes, in plain words, with the competitor's name (or the hypothesis) set apart. */
function ProposalAction({ proposal }: { proposal: OwnerProposalView }) {
  const t = useT();
  const action = describeProposalAction(proposal);
  return (
    <p className="text-sm text-zinc-100">
      <span className="font-medium">{t(action.key, action.values)}</span>
      {action.subject && (
        <>
          {": "}
          <span className="font-semibold text-white">{action.subject}</span>
        </>
      )}
    </p>
  );
}

/** The proposer's explanation; a system proposal is worded by the interface from its facts. */
function ProposalText({ proposal }: { proposal: OwnerProposalView }) {
  const t = useT();
  const facts = systemInactiveFacts(proposal);
  const text = !facts
    ? proposal.text
    : facts.latestUploadPublishedAt
      ? t("agentProposals.systemInactive", { date: formatDisplayDate(facts.latestUploadPublishedAt), months: facts.inactiveAfterMonths })
      : t("agentProposals.systemInactiveNoDate", { months: facts.inactiveAfterMonths });
  return <p className="whitespace-pre-wrap rounded-md border-l-2 border-violet-500/50 bg-zinc-900/60 py-1.5 pl-3 pr-2 text-sm text-zinc-300">{text}</p>;
}

/**
 * BL-163 (FO-REQ-0014 §C7, docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.C) -- the ONLY place an agent proposal is
 * approved or rejected. Approve is one action; Reject opens a comment box inside the card (never a native dialog) and needs text,
 * because it is the agent's only explanation. One decision at a time. `onChanged` refreshes the inbox count at once; a new
 * `pendingCount` from the summary poll (a proposal filed in the background) reloads the list.
 */
export function AgentProposalsPanel({ onChanged, pendingCount }: { onChanged?: () => void; pendingCount?: number | null } = {}) {
  const t = useT();
  const [pending, setPending] = useState<OwnerProposalView[]>([]);
  const [decided, setDecided] = useState<OwnerProposalView[] | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<OwnerProposalView | null>(null);
  // Only the newest reload writes its result: an older one finishing last must not bring back a decided card.
  const requestSeq = useRef(0);
  const showDecidedRef = useRef(showDecided);
  showDecidedRef.current = showDecided;

  const load = useCallback(async (view: "pending" | "decided") => {
    const res = await fetch(`/api/agent-proposals?view=${view}`);
    if (!res.ok) throw new Error(String(res.status));
    return ((await res.json()) as { proposals: OwnerProposalView[] }).proposals;
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const nextPending = await load("pending");
      const nextDecided = showDecidedRef.current ? sortDecided(await load("decided")) : null;
      if (seq !== requestSeq.current) return;
      setPending(nextPending);
      if (nextDecided) setDecided(nextDecided);
      setLoadError(null);
    } catch {
      if (seq === requestSeq.current) setLoadError(t("agentProposals.loadFailed"));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [load, t]);

  useEffect(() => {
    void refresh();
  }, [refresh, showDecided, pendingCount]);

  async function decide(proposal: OwnerProposalView, action: "approve" | "reject") {
    if (busyId) return;
    setBusyId(proposal.proposalId);
    setErrors((current) => ({ ...current, [proposal.proposalId]: "" }));
    try {
      const res = await fetch(`/api/agent-proposals/${encodeURIComponent(proposal.proposalId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "reject" ? { comment } : {}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; proposal?: OwnerProposalView };
      if (!res.ok) {
        setErrors((current) => ({ ...current, [proposal.proposalId]: errorText(t, data, t("agentProposals.actionFailed"), { showErrorField: false }) }));
        if (data.error && STALE_CODES.has(data.error)) await refresh();
        return;
      }
      if (rejectingId === proposal.proposalId) {
        setRejectingId(null);
        setComment("");
      }
      // Approved but not applied: said at the top of the panel, with the card's own words and the reason.
      setFailed(data.proposal?.status === "failed" ? { ...proposal, ...data.proposal, channelTitle: proposal.channelTitle, targetLabel: proposal.targetLabel } : null);
      await refresh();
      onChanged?.();
    } catch {
      setErrors((current) => ({ ...current, [proposal.proposalId]: t("agentProposals.actionFailed") }));
    } finally {
      setBusyId(null);
    }
  }

  const anyBusy = busyId !== null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("agentProposals.title")}
          {pending.length > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">{pending.length}</span>}
          <InfoTooltip>{t("agentProposals.info")}</InfoTooltip>
        </h3>
        <button type="button" onClick={() => setShowDecided((value) => !value)} className="text-xs text-zinc-400 hover:text-zinc-200">
          {t(showDecided ? "agentProposals.hideDecided" : "agentProposals.showDecided")}
        </button>
      </div>

      {failed && failed.applyError && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">
          <p>{t("agentProposals.failedBanner", { action: actionLine(t, failed), error: applyErrorText(t, failed.applyError) })}</p>
          <button type="button" onClick={() => setFailed(null)} className="shrink-0 text-xs text-rose-300 hover:text-rose-100">
            {t("common.close")}
          </button>
        </div>
      )}
      {loadError && <p className="text-sm text-red-400">{loadError}</p>}
      {!loading && !loadError && pending.length === 0 && <p className="text-sm text-zinc-500">{t("agentProposals.empty")}</p>}

      <div className="space-y-3">
        {pending.map((proposal) => {
          const busy = busyId === proposal.proposalId;
          const rejecting = rejectingId === proposal.proposalId;
          const payload = proposal.payload;
          const isSystem = proposal.source === "system";
          const isDelete = proposal.kind === "watchlist.delete";
          return (
            <div key={proposal.proposalId} className="space-y-2.5 rounded-lg border border-zinc-700/80 bg-zinc-950/40 p-3.5">
              <ProposalMeta proposal={proposal} />
              <ProposalAction proposal={proposal} />
              <ProposalText proposal={proposal} />
              {proposal.kind === "watchlist.add" && typeof payload.reason === "string" && (
                <p className="text-xs text-zinc-400">{t("agentProposals.reason", { reason: payload.reason })}</p>
              )}
              {proposal.kind === "hypothesis.add" && typeof payload.evidenceNotes === "string" && (
                <p className="whitespace-pre-wrap text-xs text-zinc-400">{t("agentProposals.evidence", { notes: payload.evidenceNotes })}</p>
              )}

              {rejecting ? (
                <div className="space-y-2">
                  {isSystem && isDelete && <p className="text-xs text-zinc-400">{t("agentProposals.systemRejectHint")}</p>}
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    aria-label={t("agentProposals.rejectLabel")}
                    placeholder={t(isSystem ? "agentProposals.rejectPlaceholderSystem" : "agentProposals.rejectPlaceholder")}
                    maxLength={2000}
                    rows={3}
                    autoFocus
                    disabled={busy}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 disabled:opacity-50"
                  />
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingId(null);
                        setComment("");
                      }}
                      disabled={busy}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(proposal, "reject")}
                      disabled={anyBusy || comment.trim().length === 0}
                      className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm font-medium text-rose-200 hover:border-rose-400/70 hover:bg-rose-500/20 disabled:opacity-50"
                    >
                      {busy ? t("agentProposals.rejecting") : t("agentProposals.rejectSend")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {/* Deleting is final, so its approval looks like the deletion it is. */}
                  <button
                    type="button"
                    onClick={() => void decide(proposal, "approve")}
                    disabled={anyBusy}
                    className={`min-w-32 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                      isDelete
                        ? "border-rose-500/50 bg-rose-500/15 text-rose-100 hover:border-rose-400/80 hover:bg-rose-500/25"
                        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400/70 hover:bg-emerald-500/20"
                    }`}
                  >
                    {busy ? t("agentProposals.approving") : t(isDelete ? "agentProposals.approveDelete" : "agentProposals.approve")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRejectingId(proposal.proposalId);
                      setComment("");
                    }}
                    disabled={anyBusy}
                    className="min-w-32 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-rose-500/50 hover:text-rose-200 disabled:opacity-50"
                  >
                    {t("agentProposals.reject")}
                  </button>
                </div>
              )}
              {errors[proposal.proposalId] && <p className="text-sm text-red-400">{errors[proposal.proposalId]}</p>}
            </div>
          );
        })}
      </div>

      {showDecided && (
        <div className="space-y-2 border-t border-zinc-800 pt-3">
          {decided === null && <p className="text-xs text-zinc-500">{t("agentProposals.loading")}</p>}
          {decided !== null && decided.length === 0 && <p className="text-xs text-zinc-500">{t("agentProposals.decidedEmpty")}</p>}
          {(decided ?? []).map((proposal) => (
            <div key={proposal.proposalId} className="space-y-1 rounded-md bg-zinc-950/30 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_TONE[proposal.status]}`}>{t(STATUS_LABELS[proposal.status])}</span>
                <ProposalMeta proposal={proposal} />
              </div>
              <ProposalAction proposal={proposal} />
              {proposal.status === "rejected" && proposal.rejectComment && <p className="text-xs text-zinc-400">{proposal.rejectComment}</p>}
              {proposal.status === "failed" && proposal.applyError && (
                <p className="text-xs text-rose-300">{t("agentProposals.failedNote", { error: applyErrorText(t, proposal.applyError) })}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
