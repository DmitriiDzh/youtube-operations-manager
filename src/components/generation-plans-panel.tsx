"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanEvent, PlanNotice, PlanStageCounts, PlanStageKind, PlanView } from "@/lib/generation-plans/contracts";
import type { SharedPlan } from "@/lib/sync-gateway";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import type { Translate, UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { ownPlanModel, peerPlanModel, waveRows, type OutgoingVerdictRef, type PlanCardDevice, type PlanCardModel, type WaveRow } from "./plan-card-model";
import { useChannelNames } from "./use-channel-names";
import { InfoTooltip } from "./info-tooltip";
import { PlanReviewScreen, resultLabel, type PeerReviewSource } from "./plan-review-screen";
import { ToggleSwitch } from "./toggle-switch";
import { Popover } from "./popover";
import { useT } from "./ui-text-provider";

// BL-143 (ADR 0029, GENERATION_PLANS_PLAN.md §3): Media → Plans. Every number comes from the plans core, which derives
// it from the jobs, sessions and results when read -- this view only shows it. Polls while the tab is open.

const POLL_MS = 10_000;
const primaryButton = "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";

type PlanDetail = PlanView & { events: PlanEvent[]; cursor: string };

/** BL-143 phase 2: another device's plans as its report shows them (the route gives the active channel's only). */
type PeerDevicePlans = { deviceId: string; hostname: string | null; updatedAt: string; stale: boolean; plans: SharedPlan[] };

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

/** A plan's key in the list: this device's by its id, another device's by device and id. */
const keyOf = (device: PlanCardDevice, planId: string) => (device ? `${device.deviceId}\u0000${planId}` : planId);

/** One row of the Plans list, whichever device the plan lives on (BL-162 AC-UX-14). */
type ListRow = { key: string; planId: string; title: string; status: string; spendUsd: number; budgetUsd: number | null; waiting: number; generated: { value: number; total: number; percent: number } | null; device: PlanCardDevice };

function generatedOf(t: Translate, stages: PlanView["progress"]["stages"]): ListRow["generated"] {
  const generate = stages.find((s) => s.kind === "in_app");
  if (!generate) return null;
  const d = describeStage(t, generate.kind, generate.counts);
  return { value: d.value, total: d.total, percent: d.percent };
}

export function PlansPanel({
  active,
  onReview,
}: {
  active: boolean;
  /** BL-149: open the review screen at its own address; BL-162: `source` = another device's plan, `wave` = open on that wave. Absent = in place. */
  onReview?: (planId: string, source?: PeerReviewSource, wave?: string) => void;
}) {
  const t = useT();
  const [filter, setFilter] = useState<"active" | "history">("active");
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [reviewing, setReviewing] = useState<{ planId: string; source?: PeerReviewSource; wave?: string } | null>(null);
  const [peers, setPeers] = useState<PeerDevicePlans[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingVerdictRef[]>([]);

  const load = useCallback(() => {
    void requestJson<{ plans: PlanView[] }>(t, "/api/generation-plans").then(
      (data) => {
        setPlans(data.plans);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : t("plans.loadFailed"))
    );
    // BL-143 phase 2: the other devices' plans (the route gives the active channel's only); a failure here never hides this
    // device's own plans.
    void requestJson<{ devices: PeerDevicePlans[]; outgoing: OutgoingVerdictRef[] }>(t, "/api/generation-plans/peers").then(
      (data) => {
        setPeers(data.devices);
        setOutgoing(data.outgoing);
      },
      () => setPeers([])
    );
    const planId = selectedRef.current;
    // Only this device's plan is read again here; another device's comes with the peers' answer above.
    if (planId && !planId.includes("\u0000")) {
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

  const open = (key: string | null) => {
    selectedRef.current = key;
    setSelected(key);
    setDetail(null);
    if (key) load();
  };

  const review = (planId: string, device: PlanCardDevice, wave?: string) => {
    const source = device ? { deviceId: device.deviceId, hostname: device.hostname } : undefined;
    if (onReview) onReview(planId, source, wave);
    else setReviewing({ planId, source, wave });
  };

  // BL-162 (AC-UX-14, FO-REQ-0013 §2.1/§2.6): one list -- this device's plans and the other devices' plans of this channel.
  const inFilter = (status: string) => (filter === "active" ? status === "active" : status !== "active");
  const peerModels = peers.flatMap((d) => d.plans.map((p) => peerPlanModel(p, { deviceId: d.deviceId, hostname: d.hostname, updatedAt: d.updatedAt, stale: d.stale }, outgoing)));
  const rows: ListRow[] = [
    ...(plans ?? [])
      .filter((p) => inFilter(p.plan.status))
      .map((p) => ({ key: keyOf(null, p.plan.planId), planId: p.plan.planId, title: p.plan.title, status: p.plan.status, spendUsd: p.progress.spend.usd, budgetUsd: p.plan.budget.usd, waiting: waitingCount(p), generated: generatedOf(t, p.progress.stages), device: null })),
    ...peerModels
      .filter((m) => inFilter(m.status))
      .map((m) => ({ key: keyOf(m.device, m.planId), planId: m.planId, title: m.title, status: m.status, spendUsd: m.progress.spend.usd, budgetUsd: m.progress.budget.usd, waiting: m.waiting, generated: generatedOf(t, m.progress.stages), device: m.device })),
  ];
  const anyPeer = rows.some((r) => r.device !== null);
  const selectedModel: PlanCardModel | null = !selected
    ? null
    : selected.includes("\u0000")
      ? (peerModels.find((m) => keyOf(m.device, m.planId) === selected) ?? null)
      : detail && detail.plan.planId === selected
        ? ownPlanModel(detail)
        : null;
  // eslint-disable-next-line react-hooks/purity -- the report's age is meant to move with the clock (re-rendered by the poll)
  const now = Date.now();

  if (reviewing) return <PlanReviewScreen planId={reviewing.planId} source={reviewing.source} initialWave={reviewing.wave ?? null} onClose={() => setReviewing(null)} onChanged={load} />;

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
        {plans !== null && rows.length === 0 && <p className="text-xs text-zinc-500">{filter === "active" ? t("plans.emptyActive") : t("plans.emptyHistory")}</p>}
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" onClick={() => open(selected === r.key ? null : r.key)} className={`w-full space-y-1 rounded-lg border px-3 py-2 text-left ${selected === r.key ? "border-indigo-500 bg-zinc-800" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}>
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-medium text-zinc-100">{r.title}</span>
                  <span className="font-mono text-xs text-zinc-500">{r.planId}</span>
                  {r.status !== "active" && <span className="text-xs text-zinc-400">{planStatusLabel(t, r.status)}</span>}
                  <span className="ml-auto text-xs text-zinc-400">
                    {r.budgetUsd !== null ? t("plans.spendOf", { spent: r.spendUsd.toFixed(2), budget: r.budgetUsd.toFixed(2) }) : t("unit.usd", { value: r.spendUsd.toFixed(2) })}
                    {r.waiting > 0 ? <span className="ml-2 text-amber-300">{t("plans.waitingForYou", { count: r.waiting })}</span> : null}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                  {r.generated && (
                    <>
                      <div className="w-40 shrink-0">
                        <Bar percent={r.generated.percent} />
                      </div>
                      {t("plans.generatedOf", { value: r.generated.value, total: r.generated.total })}
                    </>
                  )}
                  {/* FO-REQ-0013 §2.1: where the plan was created stays visible, as information only. */}
                  {anyPeer && (
                    <span className={`ml-auto rounded-full border px-2 py-0.5 ${r.device?.stale ? "border-amber-800 text-amber-300" : "border-zinc-700 text-zinc-400"}`}>
                      {r.device ? t("plans.peers.reported", { device: r.device.hostname ?? r.device.deviceId, age: describeAge(t, r.device.updatedAt, now) }) : t("plans.device.here")}
                      {r.device?.stale ? ` ${t("plans.peers.stale")}` : ""}
                    </span>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      {selectedModel && <PlanDetailCard model={selectedModel} onChanged={load} onReview={(wave) => review(selectedModel.planId, selectedModel.device, wave)} />}
      {selected && !selectedModel && <p className="text-xs text-zinc-500">{t("plans.loadingPlan")}</p>}
    </div>
  );
}

/** A small "⋯" menu for the actions that are not the card's main one (BL-162 AC-UX-08). */
function ActionsMenu({ label, items }: { label: string; items: Array<{ key: string; text: string; onSelect: () => void; danger?: boolean; disabled?: boolean }> }) {
  return (
    <Popover trigger="⋯" triggerClassName={secondaryButton} label={label} align="right" panelClassName="min-w-60 p-1">
      {(close) =>
        items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
            className={`block w-full rounded px-3 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 ${item.danger ? "text-red-300 hover:bg-red-500/10" : "text-zinc-200 hover:bg-zinc-800"}`}
          >
            {item.text}
          </button>
        ))
      }
    </Popover>
  );
}

/** One number of the plan card's KPI strip (BL-162: numbers, not sentences -- owner, msg 2263). */
function Kpi({ label, value, sub, tone = "text-zinc-100", bar, onClick }: { label: string; value: string; sub?: string | null; tone?: string; bar?: { percent: number; tone: string } | null; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-xs text-zinc-400">{label}</span>
      <span className={`text-2xl font-semibold leading-tight ${tone}`}>{value}</span>
      {bar && (
        <span className="block h-1.5 w-full overflow-hidden rounded bg-zinc-800">
          <span className={`block h-full ${bar.tone}`} style={{ width: `${bar.percent}%` }} />
        </span>
      )}
      {sub ? <span className="text-xs text-zinc-500">{sub}</span> : null}
    </>
  );
  const box = "flex min-w-0 flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${box} hover:border-amber-500/60`}>
      {body}
    </button>
  ) : (
    <div className={box}>{body}</div>
  );
}

function PlanDetailCard({ model, onChanged, onReview }: { model: PlanCardModel; onChanged: () => void; onReview: (wave?: string) => void }) {
  const t = useT();
  // BL-157 (AC-MV-07): a moved plan's event names both channels.
  const { nameOf } = useChannelNames();
  const { progress, events } = model;
  const [closing, setClosing] = useState<"completed" | "cancelled" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [showAllWaves, setShowAllWaves] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const [savingReviewRejected, setSavingReviewRejected] = useState(false);
  const base = `/api/generation-plans/${encodeURIComponent(model.planId)}`;
  const openSession = progress.spend.sessions.find((s) => !s.final);
  const budgetTone = progress.budget.warnings.includes("100") ? "bg-red-500" : progress.budget.warnings.includes("80") ? "bg-amber-500" : "bg-emerald-500";
  // AC-UX-13: another device's plan is changed only there -- its actions are shown, disabled, with that device's name.
  const elsewhere = model.device ? (model.device.hostname ?? model.device.deviceId) : null;
  const waves = waveRows(model, showAllWaves);
  const generate = progress.stages.find((s) => s.kind === "in_app");
  const ownerStage = progress.stages.find((s) => s.kind === "owner_review");
  const waitingNotice = progress.notices.find((n): n is Extract<PlanNotice, { kind: "review_waiting" }> => n.kind === "review_waiting");
  // The budget and the waiting tracks are the tiles' own; the other notices stay as small badges.
  const otherNotices = progress.notices.filter((n) => n.kind !== "review_waiting" && n.kind !== "budget_80" && n.kind !== "budget_100");

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
      {/* Header: the title, one line of facts, the description folded to one line; the actions on the right (AC-UX-08). */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-lg font-semibold text-zinc-100">{model.title}</h3>
          <p className="text-xs text-zinc-500">
            {/* ui-text-ignore: "Factory Operator" is a product name */}
            <span className="font-mono">{model.planId}</span> · {model.owner === "factory" ? "Factory Operator" : t("plans.ownerYou")} · {t("plans.created", { date: formatDisplayDateTime(model.createdAt) })} · {planStatusLabel(t, model.status)}
            {elsewhere ? ` · ${t("plans.peers.reported", { device: elsewhere, age: describeAge(t, model.device?.updatedAt ?? model.createdAt, Date.now()) })}` : ""}
          </p>
          {model.note && (
            <p className={`text-xs text-zinc-400 ${showNote ? "whitespace-pre-wrap" : "truncate"}`}>
              <button type="button" onClick={() => setShowNote((v) => !v)} className="mr-1.5 text-indigo-300 hover:underline">
                {showNote ? t("plans.note.less") : t("plans.note.more")}
              </button>
              {model.note}
            </p>
          )}
          {otherNotices.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {otherNotices.map((n, i) => {
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
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {model.waiting > 0 && (
            <button type="button" onClick={() => onReview()} className={primaryButton}>
              {t("plans.reviewWaiting", { count: model.waiting })}
            </button>
          )}
          {model.status === "active" && (
            <ActionsMenu
              label={t("plans.actions.more")}
              items={[
                { key: "complete", text: elsewhere ? t("plans.markCompletedOn", { device: elsewhere }) : t("plans.markCompleted"), disabled: elsewhere !== null, onSelect: () => setClosing("completed") },
                { key: "cancel", text: elsewhere ? t("plans.cancelPlanOn", { device: elsewhere }) : t("plans.cancelPlan"), disabled: elsewhere !== null, danger: true, onSelect: () => setClosing("cancelled") },
              ]}
            />
          )}
        </div>
      </div>

      {/* The KPI strip: what waits for the owner, what was accepted, generated, spent, and how long is left. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          label={t("plans.kpi.waiting")}
          value={String(model.waiting)}
          tone={model.waiting > 0 ? "text-amber-300" : "text-zinc-100"}
          sub={waitingNotice && waitingNotice.rejected > 0 ? t("plans.kpi.waitingSplit", { passed: waitingNotice.passed, rejected: waitingNotice.rejected }) : null}
          onClick={model.waiting > 0 ? () => onReview() : undefined}
        />
        <Kpi label={t("plans.kpi.accepted")} value={String(ownerStage ? ownerStage.counts.accepted + ownerStage.counts.done : 0)} tone="text-emerald-300" sub={ownerStage && ownerStage.counts.rejected > 0 ? t("plans.kpi.rejected", { count: ownerStage.counts.rejected }) : null} />
        {generate && <Kpi label={t("plans.kpi.generated")} value={`${generate.counts.done} / ${generate.counts.planned}`} bar={{ percent: describeStage(t, generate.kind, generate.counts).percent, tone: "bg-indigo-500" }} sub={generate.counts.failed > 0 ? t("plans.stage.failed", { count: generate.counts.failed }) : null} />}
        <Kpi
          label={t("plans.kpi.budget")}
          value={progress.budget.usd !== null ? t("plans.spendOf", { spent: progress.spend.usd.toFixed(2), budget: progress.budget.usd.toFixed(2) }) : t("unit.usd", { value: progress.spend.usd.toFixed(2) })}
          tone={progress.budget.warnings.includes("100") ? "text-red-300" : progress.budget.warnings.includes("80") ? "text-amber-300" : "text-zinc-100"}
          bar={progress.budget.usedShare !== null ? { percent: Math.min(100, Math.round(progress.budget.usedShare * 100)), tone: budgetTone } : null}
          sub={t("plans.gpuMinutes", { minutes: progress.spend.gpuMinutes })}
        />
        <Kpi
          label={t("plans.kpi.left")}
          value={formatEta(t, progress.eta.seconds)}
          sub={openSession ? t("plans.nowSession", { session: openSession.sessionId.slice(0, 8), gpu: openSession.gpuTypeId ?? t("plans.gpuPending"), usd: openSession.usd.toFixed(2) }) : t("plans.noSession")}
        />
      </div>

      {/* The stages as one funnel line: how many passed each step. */}
      {progress.stages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {progress.stages.map((stage, i) => (
            <span key={stage.stageId} className="flex items-center gap-2">
              {i > 0 && <span className="text-zinc-600">→</span>}
              <span className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5">
                <span className="mr-2 text-xs text-zinc-500">{stage.title}</span>
                {stage.kind === "in_app" ? (
                  <span className="font-medium text-zinc-100">{stage.counts.done}</span>
                ) : (
                  <>
                    <span className="font-medium text-emerald-300">✓ {stage.counts.accepted + stage.counts.done}</span>
                    <span className="ml-2 font-medium text-red-300">✗ {stage.counts.rejected}</span>
                    {stage.kind === "owner_review" && model.waiting > 0 ? <span className="ml-2 text-amber-300">· {t("plans.waitingForYou", { count: model.waiting })}</span> : null}
                  </>
                )}
              </span>
            </span>
          ))}
          {model.status === "active" && (
            <span className="ml-auto">
              {elsewhere ? (
                <span className="text-xs text-zinc-500">{t("plans.reviewRejectedOn", { device: elsewhere })}</span>
              ) : (
                <span className="flex items-center gap-1.5 text-xs text-zinc-300">
                  <label className="flex cursor-pointer items-center gap-2">
                    <ToggleSwitch label={t("plans.reviewRejected")} checked={model.reviewRejected === true} disabled={savingReviewRejected} onChange={(on) => void setReviewRejected(on)} />
                    <span>{t("plans.reviewRejected")}</span>
                  </label>
                  <InfoTooltip>{t("plans.reviewRejectedInfo")}</InfoTooltip>
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {/* The waves as a table (AC-UX-10): newest first, counts as numbers, the long texts behind a click. */}
      {model.groups.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-zinc-950 text-xs text-zinc-500">
              <tr>
                <th className="w-20 px-3 py-2 text-left font-normal">{t("plans.waves.colWave")}</th>
                <th className="px-3 py-2 text-left font-normal">{t("plans.waves.colAbout")}</th>
                <th className="w-24 px-2 py-2 text-right font-normal">{t("plans.waves.colGenerated")}</th>
                <th className="w-14 px-2 py-2 text-right font-normal">✓</th>
                <th className="w-14 px-2 py-2 text-right font-normal">✗</th>
                <th className="w-16 px-2 py-2 text-right font-normal">{t("plans.waves.colWaiting")}</th>
                <th className="w-36 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {waves.shown.map((row) => (
                <WaveTableRow key={row.groupId} planId={model.planId} row={row} editable={model.status === "active" && elsewhere === null} onSaved={onChanged} onReview={model.status === "active" ? () => onReview(row.groupId) : undefined} />
              ))}
            </tbody>
          </table>
          {(waves.folded > 0 || showAllWaves) && (
            <button type="button" onClick={() => setShowAllWaves((v) => !v)} className="w-full border-t border-zinc-800 px-3 py-2 text-left text-xs text-indigo-300 hover:bg-zinc-950">
              {showAllWaves ? t("plans.waves.fewer") : t("plans.waves.more", { count: waves.folded })}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <button type="button" onClick={() => setShowItems((v) => !v)} className="text-indigo-300 hover:underline">
          {showItems ? t("plans.hideItems") : t("plans.showItems", { count: progress.items.length })}
        </button>
      </div>
      {showItems && (
        <div className="overflow-x-auto">
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

/** One wave in the card's table; a click on its description opens the factory's note and the owner's own note. */
function WaveTableRow({ planId, row, editable, onSaved, onReview }: { planId: string; row: WaveRow; editable: boolean; onSaved: () => void; onReview?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // BL-157 (AC-WV-04): the owner edits their own note; the factory's context (`note`) is shown apart, read-only.
  const [note, setNote] = useState(row.ownerNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const counts = row.counts;
  const cell = (n: number | undefined, tone: string) => (n && n > 0 ? <span className={tone}>{n}</span> : <span className="text-zinc-600">—</span>);
  const save = async () => {
    try {
      await postJson(t, `/api/generation-plans/${encodeURIComponent(planId)}/group-note`, { groupId: row.groupId, note: note.trim() ? note : null });
      setEditing(false);
      setError(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("plans.saveNoteFailed"));
    }
  };
  return (
    <>
      <tr className="border-t border-zinc-800 hover:bg-zinc-950/60">
        <td className="px-3 py-2 font-mono text-zinc-100">{row.groupId}</td>
        <td className="px-3 py-2">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 text-left text-zinc-300 hover:text-white">
            <span className="text-zinc-500">{open ? "▾" : "▸"}</span>
            <span className="truncate" title={row.title}>
              {row.title !== row.groupId ? row.title : ""}
            </span>
            {row.ownerNote ? (
              <span className="shrink-0 text-amber-300" title={t("plans.ownerNote", { note: row.ownerNote })}>
                ✎
              </span>
            ) : null}
          </button>
        </td>
        <td className="px-2 py-2 text-right text-zinc-300">{counts ? counts.generated : "—"}</td>
        <td className="px-2 py-2 text-right">{cell(counts?.accepted, "text-emerald-300")}</td>
        <td className="px-2 py-2 text-right">{cell(counts?.rejected, "text-red-300")}</td>
        <td className="px-2 py-2 text-right">{cell(counts?.waitingReview, "font-medium text-amber-300")}</td>
        <td className="px-3 py-2 text-right">
          {/* AC-UX-09: this wave's own review. */}
          {counts && counts.waitingReview > 0 && onReview ? (
            <button type="button" onClick={onReview} className="rounded-md border border-indigo-500/60 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/15">
              {t("plans.reviewWaiting", { count: counts.waitingReview })}
            </button>
          ) : null}
        </td>
      </tr>
      {open && (
        <tr className="bg-zinc-950/60">
          <td />
          <td colSpan={6} className="space-y-2 px-3 pb-3 text-xs">
            {row.dependsOn && <p className="text-zinc-500">{t("plans.after", { group: row.dependsOn })}</p>}
            {row.note && <p className="whitespace-pre-wrap text-zinc-400">{row.note}</p>}
            {!editing && row.ownerNote && <p className="whitespace-pre-wrap text-amber-200">{t("plans.ownerNote", { note: row.ownerNote })}</p>}
            {editing ? (
              <div className="space-y-1">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100" placeholder={t("plans.notePlaceholder")} />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void save()} className={primaryButton}>
                    {t("plans.saveNote")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setNote(row.ownerNote ?? "");
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
                    setNote(row.ownerNote ?? "");
                    setEditing(true);
                  }}
                  className="text-indigo-300 hover:underline"
                >
                  ✎ {row.ownerNote ? t("plans.editNote") : t("plans.addNote")}
                </button>
              )
            )}
            {error && <p className="text-red-400">{error}</p>}
          </td>
        </tr>
      )}
    </>
  );
}
