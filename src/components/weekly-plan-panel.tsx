"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { estimateUploadUnits } from "@/lib/publishing/publish-dates";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { useT, useUiText } from "./ui-text-provider";
import { useUserTimezone } from "./use-user-timezone";
import {
  changedField,
  defaultWeek,
  lengthLabel,
  pipelineOf,
  shiftWeek,
  slotsToApprove,
  tileCounts,
  wallParts,
  zonedParts,
  type PipelineStep,
  type PipelineStepState,
  type PlanDto,
  type PlanSlotDto,
  type PlanSummaryDto,
} from "./weekly-plan-model";

// BL-225 (FO-REQ-0040; WEEKLY_PUBLISHING_PLAN.md stage 1 item 6; owner msgs 3511 and 3534, the approved mockup): Контент → «План
// недели». The questions the owner brings, in order: is a week waiting for me (the chip and the bar), when does each video come out
// (the channel's time, his own in brackets), what changed since I approved (amber rows with «было …»), and how do I stop one (the
// veto, confirmed in its own row -- never a browser dialog). «Всю неделю / По одному» is how he approves, not a setting: both write
// the same per-slot approvals; the browser only remembers which one he used last.

type Mode = "week" | "one";
const MODE_KEY = "ytom.weekPlan.mode";

function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "one" ? "one" : "week";
  } catch {
    return "week";
  }
}

const STEP_KEYS: Record<PipelineStep, UiTextKey> = {
  plan: "weekPlan.step.plan",
  video: "weekPlan.step.video",
  package: "weekPlan.step.package",
  youtube: "weekPlan.step.youtube",
  date: "weekPlan.step.date",
};
const STEP_STYLES: Record<PipelineStepState, string> = {
  done: "border-emerald-800 bg-emerald-950/70 text-emerald-300",
  active: "border-sky-800 bg-sky-950/70 text-sky-300",
  failed: "border-red-800 bg-red-950/70 text-red-300",
  todo: "border-zinc-800 bg-zinc-900 text-zinc-500",
};
const STATE_STYLES: Record<PlanSummaryDto["state"] | "none", string> = {
  awaiting_approval: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  past: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  empty: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  none: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
};
const ERROR_KEYS: Record<string, UiTextKey> = {
  publishing_plan_changed: "weekPlan.error.changed",
  publishing_plan_slot_past: "weekPlan.error.past",
  publishing_plan_slot_vetoed: "weekPlan.error.vetoed",
};

/** The slot's channel time reads the same on the owner's clock (same date and time). */
function sameClock(slot: Pick<PlanSlotDto, "date" | "publishAt" | "publishAtUtc">, ownerZone: string | null): boolean {
  const owner = zonedParts(slot.publishAtUtc, ownerZone);
  return owner.ymd === slot.date && owner.time === slot.publishAt.slice(11, 16);
}

const weekdayKey = (n: number) => `weekPlan.weekday.${n}` as UiTextKey;
const actorKey = (actor: "factory" | "worker", capital = false) => (capital ? `weekPlan.actorCap.${actor}` : `weekPlan.actor.${actor}`) as UiTextKey;

export function WeeklyPlanPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const { language } = useUiText();
  const ownerZone = useUserTimezone();
  const [summaries, setSummaries] = useState<PlanSummaryDto[] | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDto | "none" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("week");
  const [confirmVeto, setConfirmVeto] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => setMode(readMode()), []);
  const chooseMode = (next: Mode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // A private window or blocked storage: the choice lasts for this page only.
    }
  };

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/publishing-plans` : null;

  const loadList = useCallback(async () => {
    if (!base) return;
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { plans: PlanSummaryDto[] };
      setSummaries(body.plans);
      setWeek((current) => current ?? defaultWeek(body.plans, zonedParts(new Date().toISOString(), null).ymd));
      setError(null);
    } catch {
      setError(t("weekPlan.loadFailed"));
    }
  }, [base, t]);

  const loadPlan = useCallback(async () => {
    if (!base || !week) return;
    try {
      const res = await fetch(`${base}/${week}`);
      if (res.status === 404) {
        setPlan("none");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setPlan(((await res.json()) as { plan: PlanDto }).plan);
      setError(null);
    } catch {
      setError(t("weekPlan.loadFailed"));
    }
  }, [base, week, t]);

  // While visible: the list and the shown week, then every minute (the agents' saves and the other computer's decisions arrive by
  // sync); a hidden tab reads nothing.
  useEffect(() => {
    if (!visible) return;
    void loadList();
    const id = setInterval(() => void loadList(), 60_000);
    return () => clearInterval(id);
  }, [visible, loadList]);
  useEffect(() => {
    if (!visible || !week) return;
    setPlan((current) => (current !== "none" && current?.weekStart === week ? current : null));
    void loadPlan();
    const id = setInterval(() => void loadPlan(), 60_000);
    return () => clearInterval(id);
  }, [visible, week, loadPlan]);

  async function decide(action: "approve" | "revoke" | "veto" | "restore", slots: Array<{ slotId: string; contentHash?: string }>, busyKey: string) {
    if (!base || !week) return;
    setBusy(busyKey);
    setActionError(null);
    try {
      const res = await fetch(`${base}/${week}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, slots }) });
      const body = (await res.json().catch(() => ({}))) as { plan?: PlanDto; error?: string };
      if (!res.ok) {
        const key = body.error ? ERROR_KEYS[body.error] : undefined;
        setActionError(key ? t(key) : t("weekPlan.error.generic", { code: body.error ?? String(res.status) }));
        await loadPlan();
        return;
      }
      if (body.plan) setPlan(body.plan);
      setConfirmVeto(null);
      void loadList();
    } catch {
      setActionError(t("weekPlan.error.generic", { code: "network" }));
    } finally {
      setBusy(null);
    }
  }

  const shown = plan && plan !== "none" && plan.weekStart === week ? plan : null;
  const toApprove = useMemo(() => (shown ? slotsToApprove(shown) : []), [shown]);
  // The owner's own time is shown only where it differs from the channel's (also when his zone is unknown and the browser's is used).
  const sameZone = shown ? shown.slots.every((s) => sameClock(s, ownerZone)) : true;

  if (!channelId) return null;

  const at = (iso: string) => {
    const p = zonedParts(iso, ownerZone);
    return `${p.day} ${p.time}`;
  };
  const rangeLabel = (weekStart: string) => {
    const end = shiftWeek(weekStart, 1);
    const last = new Date(Date.parse(`${end}T00:00:00Z`) - 86_400_000);
    const first = new Date(`${weekStart}T00:00:00Z`);
    const short = new Intl.DateTimeFormat(language, { day: "numeric", month: "short", timeZone: "UTC" });
    const withYear = new Intl.DateTimeFormat(language, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    return t("weekPlan.range", { from: short.format(first), to: withYear.format(last) });
  };
  const stateKey = shown ? (`weekPlan.state.${shown.state}` as UiTextKey) : "weekPlan.state.none";
  const stateStyle = STATE_STYLES[shown ? shown.state : "none"];
  const tiles = shown ? tileCounts(shown) : { packaged: 0, scheduled: 0 };
  const firstRelease = shown?.slots.find((s) => !s.vetoed);
  const vetoedCount = shown ? shown.counts.vetoed : 0;
  const units = toApprove.length * estimateUploadUnits({ playlist: true, deferredPublishAt: true });

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      {/* Week header: arrows, the range, the state; the approval mode on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => week && setWeek(shiftWeek(week, -1))} disabled={!week} aria-label={t("weekPlan.prevWeek")} title={t("weekPlan.prevWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ‹
          </button>
          <h2 className="text-lg font-semibold text-zinc-100">{week ? rangeLabel(week) : t("weekPlan.none")}</h2>
          <button type="button" onClick={() => week && setWeek(shiftWeek(week, 1))} disabled={!week} aria-label={t("weekPlan.nextWeek")} title={t("weekPlan.nextWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ›
          </button>
          {week && <span className={`ml-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${stateStyle}`}>{t(stateKey)}</span>}
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <span>{t("weekPlan.mode.label")}</span>
          <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5" role="group" aria-label={t("weekPlan.mode.label")}>
            {(["week", "one"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => chooseMode(value)}
                className={`rounded-md px-3 py-1 text-sm transition-colors ${mode === value ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-300 hover:text-white"}`}
              >
                {t(value === "week" ? "weekPlan.mode.week" : "weekPlan.mode.one")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}
      {!summaries && !error && <SkeletonLines lines={4} />}

      {shown && (
        <p className="text-sm text-zinc-500">
          {t(sameZone ? "weekPlan.captionSameZone" : "weekPlan.caption", { actor: t(actorKey(shown.updatedBy)), at: at(shown.updatedAt), zone: shown.timeZone })}
        </p>
      )}

      {plan === "none" && week && <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-400">{t("weekPlan.noPlan")}</p>}

      {shown && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tile label={t("weekPlan.tile.slots")} value={String(shown.counts.slots)} />
            <Tile label={t("weekPlan.tile.packages")} value={t("weekPlan.tile.packagesValue", { n: tiles.packaged, total: shown.counts.slots - vetoedCount })} />
            <Tile label={t("weekPlan.tile.scheduled")} value={String(tiles.scheduled)} />
            <Tile
              label={t("weekPlan.tile.firstRelease")}
              value={firstRelease ? t("weekPlan.firstReleaseValue", { weekday: t(weekdayKey(wallParts(firstRelease.publishAt).weekday)), day: wallParts(firstRelease.publishAt).day, time: wallParts(firstRelease.publishAt).time }) : t("weekPlan.none")}
            />
          </div>

          {actionError && <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">{actionError}</p>}

          {shown.slots.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-400">{t("weekPlan.emptyPlan")}</p>
          ) : (
            <ul className="divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800">
              {shown.slots.map((slot, index) => (
                <SlotRow
                  key={slot.slotId}
                  channelId={channelId}
                  slot={slot}
                  number={index + 1}
                  plan={shown}
                  mode={mode}
                  ownerZone={ownerZone}
                  at={at}
                  busy={busy}
                  confirming={confirmVeto === slot.slotId}
                  onAskVeto={() => setConfirmVeto(slot.slotId)}
                  onCancelVeto={() => setConfirmVeto(null)}
                  onDecide={decide}
                />
              ))}
            </ul>
          )}

          {mode === "week" && shown.slots.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-900/60 bg-violet-950/30 px-4 py-3">
              <p className="text-sm text-zinc-200">
                {toApprove.length > 0
                  ? t(vetoedCount > 0 ? "weekPlan.bar.summaryVetoed" : "weekPlan.bar.summary", { count: toApprove.length, vetoed: vetoedCount, units })
                  : shown.state === "approved"
                    ? t("weekPlan.bar.allApproved")
                    : t("weekPlan.bar.nothing")}
              </p>
              <ActionButton
                busy={busy === "week"}
                busyLabel={t("weekPlan.action.saving")}
                disabled={toApprove.length === 0 || busy !== null}
                onClick={() => void decide("approve", toApprove, "week")}
                className="rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("weekPlan.action.approveWeek")}
              </ActionButton>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-4 py-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function SlotRow(props: {
  channelId: string;
  slot: PlanSlotDto;
  number: number;
  plan: PlanDto;
  mode: Mode;
  ownerZone: string | null;
  at: (iso: string) => string;
  busy: string | null;
  confirming: boolean;
  onAskVeto: () => void;
  onCancelVeto: () => void;
  onDecide: (action: "approve" | "revoke" | "veto" | "restore", slots: Array<{ slotId: string; contentHash?: string }>, busyKey: string) => Promise<void>;
}) {
  const t = useT();
  const { slot, plan, mode, at } = props;
  const wall = wallParts(slot.publishAt);
  const owner = zonedParts(slot.publishAtUtc, props.ownerZone);
  const dayLabel = t("weekPlan.slotDay", { weekday: t(weekdayKey(wall.weekday)), day: wall.day });
  const ownerLabel = owner.ymd === slot.date ? owner.time : t("weekPlan.slotDay", { weekday: t(weekdayKey(owner.weekday)), day: `${owner.day} ${owner.time}` });
  const changed = slot.changedAfterApproval && !slot.vetoed ? changedField(slot, plan.timeZone) : null;
  const pipeline = pipelineOf(slot);
  const busyHere = props.busy?.endsWith(`:${slot.slotId}`) ?? false;
  const anyBusy = props.busy !== null;
  const pkg = slot.package;
  const length = pkg ? lengthLabel(pkg.durationSeconds) : null;
  // BL-225 stage 2: the package's facts, each its own text (never glued into a sentence).
  const facts = pkg
    ? [
        t(length!.unit === "h" ? "weekPlan.package.hours" : "weekPlan.package.minutes", { value: length!.value }),
        t("weekPlan.package.languages", { count: pkg.languages.length }),
        ...(pkg.containsSyntheticMedia ? [t("weekPlan.package.ai")] : []),
        ...(pkg.thumbnailPath ? [pkg.testThumbnails > 0 ? t("weekPlan.package.thumbnailTests", { count: pkg.testThumbnails }) : t("weekPlan.package.thumbnail")] : []),
        ...(pkg.problems.length > 0 ? [t("weekPlan.package.problems", { count: pkg.problems.length })] : []),
      ]
    : [];
  const title = pkg
    ? t("weekPlan.package.title", { video: pkg.video, title: pkg.title })
    : slot.note && slot.lengthHint
      ? t("weekPlan.slot.titleNoteLength", { n: props.number, note: slot.note, length: slot.lengthHint })
      : slot.note
        ? t("weekPlan.slot.titleNote", { n: props.number, note: slot.note })
        : slot.lengthHint
          ? t("weekPlan.slot.titleLength", { n: props.number, length: slot.lengthHint })
          : t("weekPlan.slot.title", { n: props.number });

  let meta: { text: string; tone: string };
  if (slot.vetoed) meta = { text: t("weekPlan.vetoed", { at: at(slot.vetoed.at) }), tone: "text-red-300/80" };
  else if (changed && slot.changedAfterApproval) {
    const previous = slot.changedAfterApproval.previous;
    const was =
      changed === "time"
        ? previous.date === slot.date
          ? previous.publishAt.slice(11, 16)
          : t("weekPlan.slotDay", { weekday: t(weekdayKey(wallParts(previous.publishAt).weekday)), day: `${wallParts(previous.publishAt).day} ${wallParts(previous.publishAt).time}` })
        : changed === "length"
          ? (previous.lengthHint ?? t("weekPlan.none"))
          : previous.timeZone;
    const actor = t(actorKey(slot.changedAfterApproval.changedBy, true));
    const key = ({ time: "weekPlan.changed.time", length: "weekPlan.changed.length", note: "weekPlan.changed.note", zone: "weekPlan.changed.zone" } as const)[changed];
    meta = { text: t(key, { actor, at: at(slot.changedAfterApproval.changedAt), was }), tone: "text-amber-300" };
  } else if (slot.status === "failed") meta = { text: t("weekPlan.failed", { code: slot.statusCode ?? "?" }), tone: "text-red-300" };
  else if (slot.released) meta = { text: t("weekPlan.released"), tone: "text-zinc-500" };
  else if (slot.approval === "approved") meta = { text: t("weekPlan.approved", { at: at(slot.approvedAt ?? slot.updatedAt) }), tone: "text-emerald-300" };
  else if (mode === "one") meta = { text: t("weekPlan.notApproved"), tone: "text-zinc-400" };
  else meta = { text: slot.note ? t("weekPlan.agentNote", { note: slot.note }) : "", tone: "text-zinc-400" };

  const canAct = !slot.released;
  const afterUpload = slot.status === "uploading" || slot.status === "scheduled";

  return (
    <li className={changed ? "bg-amber-950/20" : slot.vetoed ? "bg-zinc-950/40" : undefined}>
      <div className="grid grid-cols-[6.5rem_1fr] items-center gap-3 px-4 py-3 md:grid-cols-[6.5rem_6rem_minmax(0,1fr)_auto_auto]">
        <div className={slot.vetoed ? "text-zinc-500" : "text-zinc-100"}>
          <div className={`text-sm font-medium ${slot.vetoed ? "line-through" : ""}`}>{dayLabel}</div>
          <div className="text-sm">
            {wall.time}
            {!sameClock(slot, props.ownerZone) && !slot.vetoed && <span className="ml-1 text-zinc-500">{t("weekPlan.ownerTime", { time: ownerLabel })}</span>}
          </div>
        </div>
        {pkg?.thumbnailPath ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local file served by the app's own route, not an optimisable asset
          <img
            src={`/api/channels/${encodeURIComponent(props.channelId)}/publishing/packages/thumbnail?path=${encodeURIComponent(pkg.thumbnailPath)}`}
            alt={pkg.title}
            className={`hidden h-[54px] w-24 rounded-md object-cover md:block ${slot.vetoed ? "opacity-50" : ""}`}
          />
        ) : (
          <div className="hidden h-[54px] w-24 items-center justify-center rounded-md border border-dashed border-zinc-700 text-[10px] text-zinc-500 md:flex">{t("weekPlan.noThumbnail")}</div>
        )}
        <div className="col-span-2 min-w-0 md:col-span-1">
          <div className={`truncate text-sm font-medium ${slot.vetoed ? "text-zinc-500" : "text-zinc-100"}`}>{title}</div>
          {facts.length > 0 && (
            <div className="flex flex-wrap gap-x-1.5 text-xs text-zinc-400">
              {facts.map((fact, i) => (
                <span key={i} className={pkg && i === facts.length - 1 && pkg.problems.length > 0 ? "text-amber-300" : undefined}>
                  {i > 0 && <span aria-hidden className="mr-1.5 text-zinc-600">{t("weekPlan.metaSeparator")}</span>}
                  {fact}
                </span>
              ))}
            </div>
          )}
          {meta.text && <div className={`truncate text-xs ${meta.tone}`}>{meta.text}</div>}
        </div>
        <div className="col-span-2 md:col-span-1" aria-label={t("weekPlan.pipelineLabel")}>
          {pipeline ? (
            <ol className="flex flex-wrap items-center gap-1 text-[11px]">
              {pipeline.map((step, i) => (
                <li key={step.step} className="flex items-center gap-1">
                  {i > 0 && <span aria-hidden className="text-zinc-600">›</span>}
                  <span className={`rounded border px-1.5 py-0.5 ${STEP_STYLES[step.state]}`}>{t(STEP_KEYS[step.step])}</span>
                </li>
              ))}
            </ol>
          ) : (
            <span className="text-zinc-600">{t("weekPlan.none")}</span>
          )}
        </div>
        <div className="col-span-2 flex flex-wrap justify-end gap-2 md:col-span-1">
          {canAct && slot.vetoed && (
            <ActionButton busy={props.busy === `restore:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("restore", [{ slotId: slot.slotId }], `restore:${slot.slotId}`)} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weekPlan.action.restore")}
            </ActionButton>
          )}
          {canAct && !slot.vetoed && mode === "one" && slot.approval === "approved" && (
            <ActionButton busy={props.busy === `revoke:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("revoke", [{ slotId: slot.slotId, contentHash: slot.contentHash }], `revoke:${slot.slotId}`)} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weekPlan.action.revoke")}
            </ActionButton>
          )}
          {canAct && !slot.vetoed && mode === "one" && slot.approval !== "approved" && (
            <ActionButton busy={props.busy === `approve:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("approve", [{ slotId: slot.slotId, contentHash: slot.contentHash }], `approve:${slot.slotId}`)} className="rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
              {t("weekPlan.action.approve")}
            </ActionButton>
          )}
          {canAct && !slot.vetoed && (
            <button type="button" disabled={anyBusy || busyHere} onClick={props.onAskVeto} className="rounded-md border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-40">
              {t(mode === "one" ? "weekPlan.action.vetoShort" : "weekPlan.action.veto")}
            </button>
          )}
        </div>
      </div>
      {props.confirming && !slot.vetoed && (
        <div className="flex flex-wrap items-center gap-3 border-t border-red-900/60 bg-red-950/30 px-4 py-2 text-sm text-red-100" role="alert">
          <span>
            {t("weekPlan.confirm.question", { day: dayLabel })} {t(afterUpload ? "weekPlan.confirm.afterUpload" : "weekPlan.confirm.beforeUpload")}
          </span>
          <ActionButton busy={props.busy === `veto:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("veto", [{ slotId: slot.slotId }], `veto:${slot.slotId}`)} className="rounded-md bg-red-700 px-3 py-1 font-medium text-white hover:bg-red-600 disabled:opacity-40">
            {t("weekPlan.confirm.yes")}
          </ActionButton>
          <button type="button" onClick={props.onCancelVeto} className="rounded-md border border-zinc-500 px-3 py-1 text-zinc-100 hover:bg-zinc-800">
            {t("weekPlan.confirm.cancel")}
          </button>
        </div>
      )}
    </li>
  );
}
