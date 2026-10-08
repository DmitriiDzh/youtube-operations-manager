"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanEvent, PlanNotice, PlanStageCounts, PlanStageKind, PlanView } from "@/lib/generation-plans/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { useChannelNames } from "./use-channel-names";
import { InfoTooltip } from "./info-tooltip";
import { PlanReviewScreen, resultLabel, type PeerReviewSource } from "./plan-review-screen";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-143 (ADR 0029, GENERATION_PLANS_PLAN.md §3): Media → Plans. Every number comes from the plans core, which derives
// it from the jobs, sessions and results when read -- this view only shows it. Polls while the tab is open.

const POLL_MS = 10_000;
const primaryButton = "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";

type PlanDetail = PlanView & { events: PlanEvent[]; cursor: string };

/** BL-143 phase 2: another device's plans as its report shows them (read-only here). */
type PeerDevicePlans = {
  deviceId: string;
  hostname: string | null;
  updatedAt: string;
  stale: boolean;
  plans: Array<{ planId: string; title: string; status: string; channelId: string; progress: { stages?: Array<{ stageId: string; title: string; kind: PlanStageKind; counts: PlanStageCounts }>; spend?: { usd: number }; items?: Array<{ waitingReview: number }> }; review: Array<{ itemKey: string; attemptRef: string; verdict: unknown }>; groups: Array<{ groupId: string; title: string; note: string | null; ownerNote?: string | null }> }>;
};
type OutgoingVerdict = { ownerDeviceId: string; planId: string; itemKey: string; attemptRef: string };

/** "2 min ago" / "1 h ago" for a report's age. Exported for its test. */
export function describeAge(t: Translate, updatedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000));
  if (minutes < 1) return t("plans.age.justNow");
  if (minutes < 60) return t("plans.age.minutes", { count: minutes });
  return t("plans.age.hours", { count: Math.round(minutes / 60) });
}

async function requestJson<T>(t: Translate, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? t("plans.requestFailed", { url, status: String(res.status) }));
  return data as T;
}

const postJson = (t: Translate, url: string, body: unknown) => requestJson(t, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A plan's status in words; a status from a newer device's report shows as it is. */
function planStatusLabel(t: Translate, status: string): string {
  if (status === "active") return t("plans.status.active");
  if (status === "completed") return t("plans.status.completed");
  if (status === "cancelled") return t("plans.status.cancelled");
  return status;
}

/** One stage's bar: how much of the plan's target has passed it, and the counts in words. Exported for its test. */
export function describeStage(t: Translate, kind: PlanStageKind, counts: PlanStageCounts): { value: number; total: number; percent: number; words: string } {
  const value = kind === "in_app" ? counts.done : counts.accepted + counts.done;
  const total = Math.max(counts.planned, 1);
  const parts: string[] = [];
  const add = (n: number, key: UiTextKey) => {
    if (n > 0) parts.push(t(key, { count: n }));
  };
  if (kind === "in_app") {
    add(counts.done, "plans.stage.done");
    add(counts.running, "plans.stage.running");
    add(counts.queued, "plans.stage.queued");
    add(counts.failed, "plans.stage.failed");
    add(counts.interrupted, "plans.stage.interrupted");
    add(counts.cancelled, "plans.stage.cancelled");
  } else {
    add(counts.accepted, "plans.stage.accepted");
    add(counts.done, "plans.stage.done");
    add(counts.rejected, "plans.stage.rejected");
    add(counts.failed, "plans.stage.failed");
  }
  return { value, total: counts.planned, percent: Math.min(100, Math.round((value / total) * 100)), words: parts.join(" · ") || t("plans.stage.nothingYet") };
}

/** "about 6 min" / "about 1 h 20 min"; "—" when unknown. Exported for its test. */
export function formatEta(t: Translate, seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return t("plans.eta.underMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("plans.eta.minutes", { minutes });
  return t("plans.eta.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** A notice in words and its tone (AC-GP3-01). Exported for its test. */
export function describeNotice(t: Translate, notice: PlanNotice): { text: string; tone: "ok" | "warn" | "bad" | "info" } {
  switch (notice.kind) {
    case "stage_complete":
      return { text: t("plans.notice.stageComplete", { title: notice.title }), tone: "ok" };
    case "budget_80":
      return { text: t("plans.notice.budget80"), tone: "warn" };
    case "budget_100":
      return { text: t("plans.notice.budget100"), tone: "bad" };
    case "plan_complete":
      return { text: t("plans.notice.planComplete"), tone: "ok" };
    case "review_waiting":
      // BL-153: with rejected tracks in the queue, the two counts (a notice from an older device has neither: all passed).
      return notice.rejected > 0
        ? { text: t("plans.notice.reviewWaitingSplit", { count: notice.count, passed: notice.passed ?? notice.count - notice.rejected, rejected: notice.rejected }), tone: "info" }
        : { text: t("plans.notice.reviewWaiting", { count: notice.count }), tone: "info" };
    case "attempts_exhausted":
      return { text: t("plans.notice.attemptsExhausted", { count: notice.count }), tone: "warn" };
    default: {
      // A notice kind from a newer device's report: shown by name, never a crash.
      const kind = (notice as { kind?: unknown }).kind;
      return { text: kind === undefined || kind === null ? t("plans.notice.unknown") : String(kind).replace(/_/g, " "), tone: "info" };
    }
  }
}

const NOTICE_TONES = { ok: "border-emerald-500/40 text-emerald-300", warn: "border-amber-500/40 text-amber-300", bad: "border-red-500/50 text-red-300", info: "border-indigo-500/40 text-indigo-300" } as const;

/** An event in one line. Exported for its test. */
const JOB_EVENT_KEYS: Record<string, UiTextKey> = {
  job_done: "plans.event.jobDone",
  job_failed: "plans.event.jobFailed",
  job_interrupted: "plans.event.jobInterrupted",
  job_cancelled: "plans.event.jobCancelled",
};

/** `channelName` (BL-157): a connected channel's name for a channel id; an unknown channel shows its id. */
export function describeEvent(t: Translate, event: PlanEvent, channelName: (channelId: string) => string = (id) => id): string {
  const d = event.details as Record<string, unknown>;
  // The item key, the seed, the GPU, a stop reason and an error are data, shown as they are.
  const item = typeof d.itemKey === "string" ? ` ${d.itemKey}` : "";
  switch (event.kind) {
    case "job_created":
      return typeof d.seed === "number" ? t("plans.event.jobCreatedSeed", { item, seed: String(d.seed) }) : t("plans.event.jobCreated", { item });
    case "job_done":
    case "job_failed":
    case "job_interrupted":
    case "job_cancelled":
      return t(JOB_EVENT_KEYS[event.kind], { item, error: typeof d.error === "string" ? `: ${d.error}` : "" });
    case "session_started":
      return typeof d.gpuTypeId === "string" ? t("plans.event.sessionStartedOn", { gpu: d.gpuTypeId }) : t("plans.event.sessionStarted");
    case "session_ready":
      return typeof d.gpuTypeId === "string" ? t("plans.event.sessionReadyOn", { gpu: d.gpuTypeId }) : t("plans.event.sessionReady");
    case "session_stopped":
      return typeof d.stopReason === "string" ? t("plans.event.sessionStoppedReason", { reason: d.stopReason }) : t("plans.event.sessionStopped");
    case "owner_verdict":
      return typeof d.rating === "number"
        ? t("plans.event.ownerVerdictRating", { item, result: resultLabel(t, d.result), rating: String(d.rating) })
        : t("plans.event.ownerVerdict", { item, result: resultLabel(t, d.result) });
    case "result_reported":
      return t("plans.event.resultReported", { stage: String(d.stageId), item, result: resultLabel(t, d.result) });
    case "rerun_requested":
      return t("plans.event.rerunRequested", { item });
    case "peer_verdict":
      // BL-157 (review round 1): an older verdict from the other computer is kept in the history, not applied.
      return d.superseded === true
        ? t("plans.event.peerVerdictSuperseded", { device: String(d.fromDevice), item, result: resultLabel(t, d.result) })
        : t("plans.event.peerVerdict", { device: String(d.fromDevice), item, result: resultLabel(t, d.result) });
    case "group_note":
      return t("plans.event.groupNote", { group: String(d.groupId) });
    case "stage_run":
      return t("plans.event.stageRun", { count: String(d.created) });
    case "group_reviewed":
      return t("plans.event.groupReviewed", { group: String(d.groupId), accepted: Number(d.accepted) || 0, rejected: Number(d.rejected) || 0 });
    case "plan_moved":
      return t("plans.event.planMoved", { from: channelName(String(d.from)), to: channelName(String(d.to)) });
    default:
      return event.kind.replace(/_/g, " ");
  }
}

function Bar({ percent, tone = "bg-indigo-500" }: { percent: number; tone?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function waitingCount(view: PlanView): number {
  return view.progress.items.reduce((sum, i) => sum + i.waitingReview, 0);
}

export function PlansPanel({
  active,
  onReview,
}: {
  active: boolean;
  /** BL-149: open the review screen at its own address (`/production/plans/<id>/review`); absent = in place, as before. */
  onReview?: (planId: string, source?: PeerReviewSource) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<"active" | "history">("active");
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [reviewing, setReviewing] = useState<{ planId: string; source?: PeerReviewSource } | null>(null);
  const [peers, setPeers] = useState<PeerDevicePlans[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingVerdict[]>([]);

  const load = useCallback(() => {
    void requestJson<{ plans: PlanView[] }>(t, "/api/generation-plans").then(
      (data) => {
        setPlans(data.plans);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : t("plans.loadFailed"))
    );
    // BL-143 phase 2: the other devices' plans; a failure here never hides this device's own plans.
    void requestJson<{ devices: PeerDevicePlans[]; outgoing: OutgoingVerdict[] }>(t, "/api/generation-plans/peers").then(
      (data) => {
        setPeers(data.devices);
        setOutgoing(data.outgoing);
      },
      () => setPeers([])
    );
    const planId = selectedRef.current;
    if (planId) {
      void requestJson<PlanDetail>(t, `/api/generation-plans/${encodeURIComponent(planId)}`).then(
        (data) => {
          if (selectedRef.current === planId) setDetail(data);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("plans.loadPlanFailed"))
      );
    }
  }, [t]);

  useEffect(() => {
    // Not while the review screen is open (it loads its own queue).
    if (!active || reviewing) return;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load, reviewing]);

  const open = (planId: string | null) => {
    selectedRef.current = planId;
    setSelected(planId);
    setDetail(null);
    if (planId) load();
  };

  const shown = (plans ?? []).filter((p) => (filter === "active" ? p.plan.status === "active" : p.plan.status !== "active"));

  if (reviewing) return <PlanReviewScreen planId={reviewing.planId} source={reviewing.source} onClose={() => setReviewing(null)} onChanged={load} />;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
            {t("plans.title")}
            <InfoTooltip>{t("plans.titleInfo")}</InfoTooltip>
          </h3>
          <div className="ml-auto inline-flex gap-1 rounded-lg bg-zinc-950 p-1">
            {(["active", "history"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-md px-3 py-1 text-xs font-medium ${filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
                {f === "active" ? t("plans.filter.active") : t("plans.filter.history")}
              </button>
            ))}
          </div>
        </div>
        {plans === null && !error && <p className="text-xs text-zinc-500">{t("common.loading")}</p>}
        {plans !== null && shown.length === 0 && <p className="text-xs text-zinc-500">{filter === "active" ? t("plans.emptyActive") : t("plans.emptyHistory")}</p>}
        <ul className="space-y-2">
          {shown.map((p) => {
            const generate = p.progress.stages.find((s) => s.kind === "in_app");
            const bar = generate ? describeStage(t, generate.kind, generate.counts) : null;
            const waiting = waitingCount(p);
            return (
              <li key={p.plan.planId}>
                <button type="button" onClick={() => open(selected === p.plan.planId ? null : p.plan.planId)} className={`w-full space-y-1 rounded-lg border px-3 py-2 text-left ${selected === p.plan.planId ? "border-indigo-500 bg-zinc-800" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}>
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium text-zinc-100">{p.plan.title}</span>
                    <span className="font-mono text-xs text-zinc-500">{p.plan.planId}</span>
                    {p.plan.status !== "active" && <span className="text-xs text-zinc-400">{planStatusLabel(t, p.plan.status)}</span>}
                    <span className="ml-auto text-xs text-zinc-400">
                      {p.plan.budget.usd !== null
                        ? t("plans.spendOf", { spent: p.progress.spend.usd.toFixed(2), budget: p.plan.budget.usd.toFixed(2) })
                        : t("unit.usd", { value: p.progress.spend.usd.toFixed(2) })}
                      {waiting > 0 ? <span className="ml-2 text-amber-300">{t("plans.waitingForYou", { count: waiting })}</span> : null}
                    </span>
                  </div>
                  {bar && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <div className="w-40 shrink-0">
                        <Bar percent={bar.percent} />
                      </div>
                      {t("plans.generatedOf", { value: bar.value, total: bar.total })}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      {selected && detail && <PlanDetailCard detail={detail} onChanged={load} onReview={(planId) => (onReview ? onReview(planId) : setReviewing({ planId }))} />}
      {peers.some((d) => d.plans.length > 0) && <PeerPlansCard devices={peers} outgoing={outgoing} onReview={(planId, source) => (onReview ? onReview(planId, source) : setReviewing({ planId, source }))} />}
      {selected && !detail && <p className="text-xs text-zinc-500">{t("plans.loadingPlan")}</p>}
    </div>
  );
}

function PlanDetailCard({ detail, onChanged, onReview }: { detail: PlanDetail; onChanged: () => void; onReview?: (planId: string) => void }) {
  const t = useT();
  // BL-157 (AC-MV-07): a moved plan's event names both channels.
  const { nameOf } = useChannelNames();
  const { plan, progress, events } = detail;
  const [closing, setClosing] = useState<"completed" | "cancelled" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [savingReviewRejected, setSavingReviewRejected] = useState(false);
  const waiting = waitingCount(detail);
  const base = `/api/generation-plans/${encodeURIComponent(plan.planId)}`;
  const openSession = progress.spend.sessions.find((s) => !s.final);
  const budgetTone = progress.budget.warnings.includes("100") ? "bg-red-500" : progress.budget.warnings.includes("80") ? "bg-amber-500" : "bg-emerald-500";

  const close = async (status: "completed" | "cancelled") => {
    try {
      await postJson(t, `${base}/close`, { status });
      setClosing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("plans.closeFailed"));
      setClosing(null);
    }
  };

  // BL-153 (FO-REQ-0008): the owner's switch for validator-rejected tracks in the review queue.
  const setReviewRejected = async (on: boolean) => {
    setSavingReviewRejected(true);
    try {
      await postJson(t, `${base}/review-rejected`, { reviewRejected: on });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.saveFailed"));
    } finally {
      setSavingReviewRejected(false);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{plan.title}</h3>
          <p className="text-xs text-zinc-500">
            {/* ui-text-ignore: "Factory Operator" is a product name */}
            <span className="font-mono">{plan.planId}</span> · {plan.owner === "factory" ? "Factory Operator" : t("plans.ownerYou")} · {t("plans.created", { date: formatDisplayDateTime(plan.createdAt) })} · {planStatusLabel(t, plan.status)}
          </p>
          {plan.note && <p className="mt-1 text-xs text-zinc-400">{plan.note}</p>}
          {progress.notices.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {progress.notices.map((n, i) => {
                const d = describeNotice(t, n);
                return (
                  <span key={i} className={`rounded-full border px-2 py-0.5 text-xs ${NOTICE_TONES[d.tone]}`}>
                    {d.text}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {waiting > 0 && onReview && (
            <button type="button" onClick={() => onReview(plan.planId)} className={primaryButton}>
              {t("plans.reviewWaiting", { count: waiting })}
            </button>
          )}
          {plan.status === "active" && (
            <>
              <span className="flex items-center gap-1">
                <ToggleSwitch label={t("plans.reviewRejected")} checked={plan.reviewRejected === true} disabled={savingReviewRejected} onChange={(on) => void setReviewRejected(on)} />
                <InfoTooltip>{t("plans.reviewRejectedInfo")}</InfoTooltip>
              </span>
              <button type="button" onClick={() => setClosing("completed")} className={secondaryButton}>
                {t("plans.markCompleted")}
              </button>
              <button type="button" onClick={() => setClosing("cancelled")} className={secondaryButton}>
                {t("plans.cancelPlan")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-3 text-xs text-zinc-400 sm:grid-cols-3">
        <div className="space-y-1">
          <div>
            {progress.budget.usd !== null
              ? t("plans.spendBudget", { spent: progress.spend.usd.toFixed(2), budget: progress.budget.usd.toFixed(2) })
              : t("plans.spendNoBudget", { spent: progress.spend.usd.toFixed(2) })}
            {progress.budget.warnings.includes("100") ? <span className="ml-1 text-red-400">{t("plans.overBudget")}</span> : progress.budget.warnings.includes("80") ? <span className="ml-1 text-amber-300">{t("plans.used80")}</span> : null}
          </div>
          {progress.budget.usedShare !== null && <Bar percent={Math.min(100, Math.round(progress.budget.usedShare * 100))} tone={budgetTone} />}
          <div className="text-zinc-500">{t("plans.gpuMinutes", { minutes: progress.spend.gpuMinutes })}</div>
        </div>
        <div>
          {t("plans.timeLeft", { eta: formatEta(t, progress.eta.seconds) })}
          <div className="text-zinc-500">{progress.eta.gpuTypeId ? t("plans.etaFrom", { count: progress.eta.samples, gpu: progress.eta.gpuTypeId }) : t("plans.noGpuYet")}</div>
        </div>
        <div>
          {openSession ? (
            <>{t("plans.nowSession", { session: openSession.sessionId.slice(0, 8), gpu: openSession.gpuTypeId ?? t("plans.gpuPending"), usd: openSession.usd.toFixed(2) })}</>
          ) : (
            <span className="text-zinc-500">{t("plans.noSession")}</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {progress.stages.map((stage) => {
          const d = describeStage(t, stage.kind, stage.counts);
          return (
            <div key={stage.stageId} className="grid grid-cols-[8rem_1fr] items-center gap-3 text-xs sm:grid-cols-[10rem_12rem_1fr]">
              <span className="text-zinc-200">{stage.title}</span>
              <div className="flex items-center gap-2">
                <Bar percent={d.percent} tone={stage.kind === "owner_review" ? "bg-amber-500" : "bg-indigo-500"} />
                <span className="w-16 shrink-0 text-zinc-400">
                  {d.value} / {d.total}
                </span>
              </div>
              <span className="col-span-2 text-zinc-500 sm:col-span-1">{d.words}</span>
            </div>
          );
        })}
      </div>

      {progress.groups.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-zinc-200">{t("plans.waves")}</h4>
          {plan.groups.map((g) => {
            const counts = progress.groups.find((x) => x.groupId === g.groupId)?.counts;
            return <GroupRow key={g.groupId} planId={plan.planId} group={g} counts={counts} editable={plan.status === "active"} onSaved={onChanged} />;
          })}
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowItems((v) => !v)} className="text-xs text-indigo-300 hover:underline">
          {showItems ? t("plans.hideItems") : t("plans.showItems", { count: progress.items.length })}
        </button>
        {showItems && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs text-zinc-400">
              <thead>
                <tr className="text-zinc-500">
                  <th className="py-1 pr-3">{t("plans.col.item")}</th>
                  <th className="py-1 pr-3">{t("plans.col.target")}</th>
                  <th className="py-1 pr-3">{t("plans.col.attempts")}</th>
                  <th className="py-1 pr-3">{t("plans.col.generated")}</th>
                  <th className="py-1 pr-3">{t("plans.col.accepted")}</th>
                  <th className="py-1 pr-3">{t("plans.col.rejected")}</th>
                  <th className="py-1 pr-3">{t("plans.col.waiting")}</th>
                  <th className="py-1 pr-3">{t("plans.col.stillNeeded")}</th>
                </tr>
              </thead>
              <tbody>
                {progress.items.map((i) => (
                  <tr key={i.itemKey} className="border-t border-zinc-800">
                    <td className="py-1 pr-3 font-mono text-zinc-300">{i.itemKey}</td>
                    <td className="py-1 pr-3">{i.mode === "until_accepted" ? t("plans.targetAccepted", { count: i.targetCount }) : i.targetCount}</td>
                    <td className="py-1 pr-3">{i.attempts}</td>
                    <td className="py-1 pr-3">{i.generated}</td>
                    <td className="py-1 pr-3 text-emerald-400">{i.accepted}</td>
                    <td className="py-1 pr-3 text-red-400">{i.rejected}</td>
                    <td className="py-1 pr-3 text-amber-300">{i.waitingReview}</td>
                    <td className="py-1 pr-3">{i.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {events.length > 0 && (
        <details className="text-xs text-zinc-400">
          <summary className="cursor-pointer text-zinc-500">{t("plans.recentEvents", { count: Math.min(events.length, 30) })}</summary>
          <ul className="mt-1 space-y-0.5">
            {[...events]
              .reverse()
              .slice(0, 30)
              .map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  {formatDisplayDateTime(e.at)} · {describeEvent(t, e, nameOf)}
                </li>
              ))}
          </ul>
        </details>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {closing && (
        <ConfirmDialog
          title={closing === "completed" ? t("plans.confirmComplete") : t("plans.confirmCancel")}
          description={t("plans.confirmDescription")}
          confirmLabel={closing === "completed" ? t("plans.markCompleted") : t("plans.cancelPlan")}
          confirmVariant={closing === "cancelled" ? "danger" : undefined}
          onCancel={() => setClosing(null)}
          onConfirm={() => void close(closing)}
        />
      )}
    </div>
  );
}

function GroupRow({
  planId,
  group,
  counts,
  editable,
  onSaved,
}: {
  planId: string;
  group: { groupId: string; title: string; dependsOn: string | null; note: string | null; ownerNote?: string | null };
  counts: { items: number; generated: number; accepted: number; rejected: number; waitingReview: number; missing: number } | undefined;
  editable: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  // BL-157 (AC-WV-04): the owner edits their own note; the factory's context (`note`) is shown apart, read-only.
  const [note, setNote] = useState(group.ownerNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await postJson(t, `/api/generation-plans/${encodeURIComponent(planId)}/group-note`, { groupId: group.groupId, note: note.trim() ? note : null });
      setEditing(false);
      setError(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("plans.saveNoteFailed"));
    }
  };
  return (
    <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-zinc-200">{group.title}</span>
        {group.title !== group.groupId && <span className="font-mono text-zinc-500">{group.groupId}</span>}
        {group.dependsOn && <span className="text-zinc-500">{t("plans.after", { group: group.dependsOn })}</span>}
        {counts && (
          <span className="ml-auto text-zinc-400">
            {t("plans.group.items", { count: counts.items })} · {t("plans.group.generated", { count: counts.generated })} · <span className="text-emerald-400">{t("plans.group.accepted", { count: counts.accepted })}</span> ·{" "}
            <span className="text-red-400">{t("plans.group.rejected", { count: counts.rejected })}</span>
            {counts.waitingReview > 0 ? <span className="text-amber-300"> · {t("plans.group.waiting", { count: counts.waitingReview })}</span> : null}
          </span>
        )}
      </div>
      {group.note && <p className="whitespace-pre-wrap text-zinc-400">{group.note}</p>}
      {!editing && group.ownerNote && <p className="whitespace-pre-wrap text-amber-200">{t("plans.ownerNote", { note: group.ownerNote })}</p>}
      {editing ? (
        <div className="space-y-1">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100" placeholder={t("plans.notePlaceholder")} />
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} className={primaryButton}>
              {t("plans.saveNote")}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setNote(group.ownerNote ?? "");
              }}
              className={secondaryButton}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        editable && (
          <button
            type="button"
            onClick={() => {
              setNote(group.ownerNote ?? "");
              setEditing(true);
            }}
            className="text-indigo-300 hover:underline"
          >
            {group.ownerNote ? t("plans.editNote") : t("plans.addNote")}
          </button>
        )
      )}
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

/** BL-143 phase 2 (AC-GP2-06): the other devices' plans, read-only -- progress as that device reported it, and listening. */
function PeerPlansCard({ devices, outgoing, onReview }: { devices: PeerDevicePlans[]; outgoing: OutgoingVerdict[]; onReview: (planId: string, source: PeerReviewSource) => void }) {
  // Re-rendered by the panel's poll every 10 s, so the age is measured from now each time.
  // eslint-disable-next-line react-hooks/purity -- the age is meant to move with the clock
  const now = Date.now();
  const t = useT();
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {t("plans.peers.title")}
        <InfoTooltip>{t("plans.peers.info")}</InfoTooltip>
      </h3>
      {devices
        .filter((d) => d.plans.length > 0)
        .map((d) => (
          <div key={d.deviceId} className="space-y-2">
            <p className="text-xs text-zinc-400">
              {t("plans.peers.reported", { device: d.hostname ?? d.deviceId, age: describeAge(t, d.updatedAt, now) })}
              {d.stale ? <span className="ml-1 text-amber-300">{t("plans.peers.stale")}</span> : null}
            </p>
            <ul className="space-y-2">
              {d.plans.map((p) => {
                const generate = p.progress.stages?.find((s) => s.kind === "in_app");
                const bar = generate ? describeStage(t, generate.kind, generate.counts) : null;
                // Verdicts already sent from here count as given (they wait for that device to apply them).
                const sent = new Set(outgoing.filter((v) => v.ownerDeviceId === d.deviceId && v.planId === p.planId).map((v) => `${v.itemKey}\u0000${v.attemptRef}`));
                const waiting = p.review.filter((e) => e.verdict === null && !sent.has(`${e.itemKey}\u0000${e.attemptRef}`)).length;
                return (
                  <li key={p.planId} className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <div className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="font-medium text-zinc-100">{p.title}</span>
                      <span className="font-mono text-xs text-zinc-500">{p.planId}</span>
                      {p.status !== "active" && <span className="text-xs text-zinc-400">{planStatusLabel(t, p.status)}</span>}
                      <span className="ml-auto text-xs text-zinc-400">{t("unit.usd", { value: (p.progress.spend?.usd ?? 0).toFixed(2) })}</span>
                      {p.status === "active" && waiting > 0 && (
                        <button type="button" onClick={() => onReview(p.planId, { deviceId: d.deviceId, hostname: d.hostname })} className={primaryButton}>
                          {t("plans.reviewWaiting", { count: waiting })}
                        </button>
                      )}
                    </div>
                    {bar && (
                      <div className="flex items-center gap-2 text-xs text-zinc-400">
                        <div className="w-40 shrink-0">
                          <Bar percent={bar.percent} />
                        </div>
                        {t("plans.generatedOf", { value: bar.value, total: bar.total })}
                      </div>
                    )}
                    {(p.progress.stages ?? []).filter((s) => s.kind !== "in_app").map((s) => {
                      const st = describeStage(t, s.kind, s.counts);
                      return (
                        <div key={s.stageId} className="text-xs text-zinc-500">
                          {s.title}: {st.words}
                        </div>
                      );
                    })}
                    {p.groups.filter((g) => g.note || g.ownerNote).map((g) => (
                      <div key={g.groupId} className="text-xs text-zinc-400">
                        {g.title}: {[g.note, g.ownerNote ? t("plans.ownerNote", { note: g.ownerNote }) : null].filter(Boolean).join(" · ")}
                      </div>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </div>
  );
}
