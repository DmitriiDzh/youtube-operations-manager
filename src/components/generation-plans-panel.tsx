"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanEvent, PlanStageCounts, PlanStageKind, PlanView } from "@/lib/generation-plans/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { PlanReviewScreen } from "./plan-review-screen";

// BL-143 (ADR 0029, GENERATION_PLANS_PLAN.md §3): Production → Plans. Every number comes from the plans core, which derives
// it from the jobs, sessions and results when read -- this view only shows it. Polls while the tab is open.

const POLL_MS = 10_000;
const primaryButton = "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";

type PlanDetail = PlanView & { events: PlanEvent[]; cursor: string };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request to ${url} failed (${res.status})`);
  return data as T;
}

const postJson = (url: string, body: unknown) => requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** One stage's bar: how much of the plan's target has passed it, and the counts in words. Exported for its test. */
export function describeStage(kind: PlanStageKind, counts: PlanStageCounts): { value: number; total: number; percent: number; words: string } {
  const value = kind === "in_app" ? counts.done : counts.accepted + counts.done;
  const total = Math.max(counts.planned, 1);
  const parts: string[] = [];
  const add = (n: number, label: string) => {
    if (n > 0) parts.push(`${label} ${n}`);
  };
  if (kind === "in_app") {
    add(counts.done, "done");
    add(counts.running, "running");
    add(counts.queued, "queued");
    add(counts.failed, "failed");
    add(counts.interrupted, "interrupted");
    add(counts.cancelled, "cancelled");
  } else {
    add(counts.accepted, "accepted");
    add(counts.done, "done");
    add(counts.rejected, "rejected");
    add(counts.failed, "failed");
  }
  return { value, total: counts.planned, percent: Math.min(100, Math.round((value / total) * 100)), words: parts.join(" · ") || "nothing yet" };
}

/** "about 6 min" / "about 1 h 20 min"; "—" when unknown. Exported for its test. */
export function formatEta(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  return `about ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** An event in one line. Exported for its test. */
export function describeEvent(event: PlanEvent): string {
  const d = event.details as Record<string, unknown>;
  const item = typeof d.itemKey === "string" ? ` ${d.itemKey}` : "";
  switch (event.kind) {
    case "job_created":
      return `job created${item}${typeof d.seed === "number" ? ` (seed ${d.seed})` : ""}`;
    case "job_done":
    case "job_failed":
    case "job_interrupted":
    case "job_cancelled":
      return `job ${event.kind.slice(4)}${item}${typeof d.error === "string" ? `: ${d.error}` : ""}`;
    case "session_started":
    case "session_ready":
      return `session ${event.kind.slice(8)}${typeof d.gpuTypeId === "string" ? ` on ${d.gpuTypeId}` : ""}`;
    case "session_stopped":
      return `session stopped${typeof d.stopReason === "string" ? ` -- ${d.stopReason}` : ""}`;
    case "owner_verdict":
      return `your verdict${item}: ${String(d.result)}${typeof d.rating === "number" ? ` ${d.rating}/10` : ""}`;
    case "result_reported":
      return `${String(d.stageId)}${item}: ${String(d.result)} (Factory Operator)`;
    case "rerun_requested":
      return `re-run asked${item}`;
    case "group_note":
      return `note on ${String(d.groupId)}`;
    case "stage_run":
      return `stage run: ${String(d.created)} job(s)`;
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

export function PlansPanel({ active }: { active: boolean }) {
  const [filter, setFilter] = useState<"active" | "history">("active");
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const load = useCallback(() => {
    void requestJson<{ plans: PlanView[] }>("/api/generation-plans").then(
      (data) => {
        setPlans(data.plans);
        setError(null);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load the plans")
    );
    const planId = selectedRef.current;
    if (planId) {
      void requestJson<PlanDetail>(`/api/generation-plans/${encodeURIComponent(planId)}`).then(
        (data) => {
          if (selectedRef.current === planId) setDetail(data);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load the plan")
      );
    }
  }, []);

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

  if (reviewing) return <PlanReviewScreen planId={reviewing} onClose={() => setReviewing(null)} onChanged={load} />;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
            Generation plans
            <InfoTooltip>
              What the Factory Operator planned, what runs now and what is done. Counts of the generate stage come from the jobs themselves; the other stages from the Factory Operator&rsquo;s reports and your verdicts. The app never starts a session or a job for a plan by itself.
            </InfoTooltip>
          </h3>
          <div className="ml-auto inline-flex gap-1 rounded-lg bg-zinc-950 p-1">
            {(["active", "history"] as const).map((f) => (
              <button key={f} type="button" onClick={() => setFilter(f)} className={`rounded-md px-3 py-1 text-xs font-medium ${filter === f ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
                {f === "active" ? "Active" : "History"}
              </button>
            ))}
          </div>
        </div>
        {plans === null && !error && <p className="text-xs text-zinc-500">Loading…</p>}
        {plans !== null && shown.length === 0 && <p className="text-xs text-zinc-500">{filter === "active" ? "No active plans. The Factory Operator creates them (factory_plan_create / import)." : "No closed plans yet."}</p>}
        <ul className="space-y-2">
          {shown.map((p) => {
            const generate = p.progress.stages.find((s) => s.kind === "in_app");
            const bar = generate ? describeStage(generate.kind, generate.counts) : null;
            const waiting = waitingCount(p);
            return (
              <li key={p.plan.planId}>
                <button type="button" onClick={() => open(selected === p.plan.planId ? null : p.plan.planId)} className={`w-full space-y-1 rounded-lg border px-3 py-2 text-left ${selected === p.plan.planId ? "border-indigo-500 bg-zinc-800" : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"}`}>
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium text-zinc-100">{p.plan.title}</span>
                    <span className="font-mono text-xs text-zinc-500">{p.plan.planId}</span>
                    {p.plan.status !== "active" && <span className="text-xs text-zinc-400">{p.plan.status}</span>}
                    <span className="ml-auto text-xs text-zinc-400">
                      ${p.progress.spend.usd.toFixed(2)}
                      {p.plan.budget.usd !== null ? ` of $${p.plan.budget.usd.toFixed(2)}` : ""}
                      {waiting > 0 ? <span className="ml-2 text-amber-300">{waiting} waiting for you</span> : null}
                    </span>
                  </div>
                  {bar && (
                    <div className="flex items-center gap-2 text-xs text-zinc-400">
                      <div className="w-40 shrink-0">
                        <Bar percent={bar.percent} />
                      </div>
                      generated {bar.value} of {bar.total}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
      {selected && detail && <PlanDetailCard detail={detail} onChanged={load} onReview={setReviewing} />}
      {selected && !detail && <p className="text-xs text-zinc-500">Loading the plan…</p>}
    </div>
  );
}

function PlanDetailCard({ detail, onChanged, onReview }: { detail: PlanDetail; onChanged: () => void; onReview?: (planId: string) => void }) {
  const { plan, progress, events } = detail;
  const [closing, setClosing] = useState<"completed" | "cancelled" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showItems, setShowItems] = useState(false);
  const waiting = waitingCount(detail);
  const base = `/api/generation-plans/${encodeURIComponent(plan.planId)}`;
  const openSession = progress.spend.sessions.find((s) => !s.final);
  const budgetTone = progress.budget.warnings.includes("100") ? "bg-red-500" : progress.budget.warnings.includes("80") ? "bg-amber-500" : "bg-emerald-500";

  const close = async (status: "completed" | "cancelled") => {
    try {
      await postJson(`${base}/close`, { status });
      setClosing(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close the plan");
      setClosing(null);
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{plan.title}</h3>
          <p className="text-xs text-zinc-500">
            <span className="font-mono">{plan.planId}</span> · {plan.owner === "factory" ? "Factory Operator" : "you"} · created {formatDisplayDateTime(plan.createdAt)} · {plan.status}
          </p>
          {plan.note && <p className="mt-1 text-xs text-zinc-400">{plan.note}</p>}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {waiting > 0 && onReview && (
            <button type="button" onClick={() => onReview(plan.planId)} className={primaryButton}>
              Review {waiting} waiting
            </button>
          )}
          {plan.status === "active" && (
            <>
              <button type="button" onClick={() => setClosing("completed")} className={secondaryButton}>
                Mark completed
              </button>
              <button type="button" onClick={() => setClosing("cancelled")} className={secondaryButton}>
                Cancel plan
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-3 text-xs text-zinc-400 sm:grid-cols-3">
        <div className="space-y-1">
          <div>
            Spend ${progress.spend.usd.toFixed(2)}
            {progress.budget.usd !== null ? ` of $${progress.budget.usd.toFixed(2)}` : " (no budget)"}
            {progress.budget.warnings.includes("100") ? <span className="ml-1 text-red-400">over budget</span> : progress.budget.warnings.includes("80") ? <span className="ml-1 text-amber-300">80 % used</span> : null}
          </div>
          {progress.budget.usedShare !== null && <Bar percent={Math.min(100, Math.round(progress.budget.usedShare * 100))} tone={budgetTone} />}
          <div className="text-zinc-500">GPU {progress.spend.gpuMinutes} min</div>
        </div>
        <div>
          Time left {formatEta(progress.eta.seconds)}
          <div className="text-zinc-500">{progress.eta.gpuTypeId ? `from ${progress.eta.samples} finished job(s) on ${progress.eta.gpuTypeId}` : "no GPU yet"}</div>
        </div>
        <div>
          {openSession ? (
            <>
              Now: session {openSession.sessionId.slice(0, 8)} · {openSession.gpuTypeId ?? "GPU pending"} · ${openSession.usd.toFixed(2)} so far
            </>
          ) : (
            <span className="text-zinc-500">No session running for this plan</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {progress.stages.map((stage) => {
          const d = describeStage(stage.kind, stage.counts);
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
          <h4 className="text-sm font-medium text-zinc-200">Waves</h4>
          {plan.groups.map((g) => {
            const counts = progress.groups.find((x) => x.groupId === g.groupId)?.counts;
            return <GroupRow key={g.groupId} planId={plan.planId} group={g} counts={counts} editable={plan.status === "active"} onSaved={onChanged} />;
          })}
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowItems((v) => !v)} className="text-xs text-indigo-300 hover:underline">
          {showItems ? "Hide items" : `Show ${progress.items.length} items`}
        </button>
        {showItems && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs text-zinc-400">
              <thead>
                <tr className="text-zinc-500">
                  <th className="py-1 pr-3">Item</th>
                  <th className="py-1 pr-3">Target</th>
                  <th className="py-1 pr-3">Attempts</th>
                  <th className="py-1 pr-3">Generated</th>
                  <th className="py-1 pr-3">Accepted</th>
                  <th className="py-1 pr-3">Rejected</th>
                  <th className="py-1 pr-3">Waiting</th>
                  <th className="py-1 pr-3">Still needed</th>
                </tr>
              </thead>
              <tbody>
                {progress.items.map((i) => (
                  <tr key={i.itemKey} className="border-t border-zinc-800">
                    <td className="py-1 pr-3 font-mono text-zinc-300">{i.itemKey}</td>
                    <td className="py-1 pr-3">
                      {i.targetCount} {i.mode === "until_accepted" ? "accepted" : ""}
                    </td>
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
          <summary className="cursor-pointer text-zinc-500">Recent events ({Math.min(events.length, 30)})</summary>
          <ul className="mt-1 space-y-0.5">
            {[...events]
              .reverse()
              .slice(0, 30)
              .map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  {formatDisplayDateTime(e.at)} · {describeEvent(e)}
                </li>
              ))}
          </ul>
        </details>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {closing && (
        <ConfirmDialog
          title={closing === "completed" ? "Mark this plan completed?" : "Cancel this plan?"}
          description="Only the plan's status changes. Running jobs and sessions are not stopped, and no file is touched; the Factory Operator can no longer add to it."
          confirmLabel={closing === "completed" ? "Mark completed" : "Cancel plan"}
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
  group: { groupId: string; title: string; dependsOn: string | null; note: string | null };
  counts: { items: number; generated: number; accepted: number; rejected: number; waitingReview: number; missing: number } | undefined;
  editable: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(group.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await postJson(`/api/generation-plans/${encodeURIComponent(planId)}/group-note`, { groupId: group.groupId, note: note.trim() ? note : null });
      setEditing(false);
      setError(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the note");
    }
  };
  return (
    <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium text-zinc-200">{group.title}</span>
        {group.title !== group.groupId && <span className="font-mono text-zinc-500">{group.groupId}</span>}
        {group.dependsOn && <span className="text-zinc-500">after {group.dependsOn}</span>}
        {counts && (
          <span className="ml-auto text-zinc-400">
            {counts.items} items · generated {counts.generated} · <span className="text-emerald-400">accepted {counts.accepted}</span> · <span className="text-red-400">rejected {counts.rejected}</span>
            {counts.waitingReview > 0 ? <span className="text-amber-300"> · {counts.waitingReview} waiting</span> : null}
          </span>
        )}
      </div>
      {!editing && group.note && <p className="whitespace-pre-wrap text-zinc-300">{group.note}</p>}
      {editing ? (
        <div className="space-y-1">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100" placeholder="Your verdict on the whole wave, e.g. 'all too thin; start too sharp'" />
          <div className="flex gap-2">
            <button type="button" onClick={() => void save()} className={primaryButton}>
              Save note
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setNote(group.note ?? "");
              }}
              className={secondaryButton}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        editable && (
          <button
            type="button"
            onClick={() => {
              setNote(group.note ?? "");
              setEditing(true);
            }}
            className="text-indigo-300 hover:underline"
          >
            {group.note ? "Edit note" : "Add a note on this wave"}
          </button>
        )
      )}
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}
