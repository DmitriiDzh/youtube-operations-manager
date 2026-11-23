"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ThumbnailReplaceButton } from "./thumbnail-replace";
import { SlotSocialPreview } from "./slot-social-preview";
import { OrientationIcon } from "./orientation-icon";
import { VideoPlayButton } from "./video-popup";
import { PackagingActions } from "./package-packaging-actions";
import { CaptionsActions } from "./package-captions-actions";
import type { ActiveUpload } from "./plan-extras-model";
import type { PlanPackageRow } from "./plan-extras";
import { estimateUploadUnits } from "@/lib/publishing/publish-dates";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { PublishingCalendar } from "./publishing-calendar";
import { useT, useUiText } from "./ui-text-provider";
import { WeekTemplateEditor } from "./week-template-editor";
import { freePositions, localAndUtc, type TemplateAnswerDto } from "./week-template-model";
import { useUserTimezone } from "./use-user-timezone";
import {
  canApprove,
  canRetime,
  type DatingState,
  deletedOnYoutube,
  changedField,
  channelZoneOf,
  createWeekLoader,
  currentWeekStart,
  weekFromSearch,
  lengthLabel,
  pipelineOf,
  replacedToPull,
  shiftWeek,
  splitVetoed,
  ownerReviewOf,
  duplicateWarningOf,
  strayDateOf,
  tileCounts,
  wallParts,
  weekCoverageLine,
  weekDays,
  parseClock,
  zonedParts,
  type PipelineStep,
  type PipelineStepState,
  type PlanDto,
  type PlanSlotDto,
  type PlanSummaryDto,
  type WeekCoverageDto,
} from "./weekly-plan-model";

// BL-225 (FO-REQ-0040; WEEKLY_PUBLISHING_PLAN.md stage 1 item 6; owner msgs 3511 and 3534, the approved mockup): Контент → «План
// недели». The questions the owner brings, in order: is a week waiting for me (the chip and the bar), when does each video come out
// (the channel's time, his own in brackets), what changed since I approved (amber rows with «было …»), and how do I stop one (the
// veto, confirmed in its own row -- never a browser dialog). «Всю неделю / По одному» is how he approves, not a setting: both write
// the same per-slot approvals; the browser only remembers which one he used last.

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.6/§3.7/§3.9, ADR 0073; owner msgs 4569/4572/4575, 4630-4636): no slot approval any more -- the
// week approval, «Всю неделю / По одному» and the approval-stage switch are gone. «План» has three views: «Неделя» (the slots, how
// each is dated, the template's free positions as ghost rows), «Месяц» (the month calendar) and «Шаблон недели» (the editor). Every
// date-changing action is one slot behind a dialog that names the exact change; every time shows the owner's own time beside UTC.
type Mode = "one";
type View = "week" | "month" | "template";
const VIEW_KEY = "ytom.plan.view";

function readView(): View {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "month" || v === "template" ? v : "week";
  } catch {
    return "week";
  }
}

const DATING_KEYS: Record<DatingState, UiTextKey> = {
  dated: "weekTemplate.dating.dated",
  will_date: "weekTemplate.dating.willDate",
  on_template_awaiting_package: "weekTemplate.dating.awaitingPackage",
  awaiting_media_review: "weekTemplate.dating.awaitingMedia",
  off_template: "weekTemplate.dating.offTemplate",
  position_taken: "weekTemplate.dating.positionTaken",
  foreign_date: "weekTemplate.dating.foreignDate",
  vetoed: "weekTemplate.dating.vetoed",
  released: "weekTemplate.dating.released",
};
const DATING_STYLES: Record<DatingState, string> = {
  dated: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  will_date: "bg-emerald-500/10 text-emerald-200 ring-emerald-500/20",
  on_template_awaiting_package: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  awaiting_media_review: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  off_template: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  position_taken: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  foreign_date: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  vetoed: "bg-red-500/10 text-red-300 ring-red-500/20",
  released: "bg-zinc-700/40 text-zinc-400 ring-zinc-600/40",
};

/** BL-267: a move's answer (dry run or done). */
type MoveAnswer = {
  moved: boolean;
  dryRun: boolean;
  from: { weekStart: string; date: string; publishAt: string; publishAtUtc: string; timeZone: string };
  to: { weekStart: string; date: string; publishAt: string; publishAtUtc: string; timeZone: string };
  youtube: { effect: "moves" | "plan_only" | "none"; previous: string | null; result?: string; reason?: string; publishAt?: string | null };
  /** Review #7: template positions this move takes from other slots (absent from an older server). */
  displaces?: Array<{ slotId: string; weekStart: string; publishAtUtc: string; video: string | null }>;
};

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
// Owner TG 4784: the slot rows share the list's columns (CSS subgrid) -- day, thumbnail, title, the step chain, and, where the list
// is wide enough for the widest set of buttons (the `@container` holding the lists), the buttons. Narrower, the buttons take a
// second line under the title and the chain, so they never move the chain either. A list under 44rem (a phone, a narrow window beside the sidebar) keeps the stacked card.
const ROWS_GRID = "@min-[44rem]:grid @min-[44rem]:grid-cols-[7.5rem_6rem_minmax(0,1fr)_max-content] @min-[44rem]:gap-x-3 @min-[90rem]:grid-cols-[7.5rem_6rem_minmax(0,1fr)_max-content_max-content]";
const ROW_ITEM = "@min-[44rem]:col-span-full @min-[44rem]:grid @min-[44rem]:grid-cols-subgrid";
const ROW_MAIN = "grid grid-cols-[6.5rem_1fr] items-center gap-3 px-4 py-3 @min-[44rem]:col-span-full @min-[44rem]:grid-cols-subgrid @min-[44rem]:gap-y-2";
const ROW_CHAIN = "col-span-2 @min-[44rem]:col-span-1";
const ROW_ACTIONS = "col-span-2 flex flex-wrap justify-end gap-2 @min-[44rem]:col-span-2 @min-[44rem]:col-start-3 @min-[90rem]:col-span-1 @min-[90rem]:col-start-5 @min-[90rem]:flex-nowrap";
const SIZER_ACTIONS = "hidden flex-col gap-1 @min-[90rem]:col-start-5 @min-[90rem]:flex";
const STATE_STYLES: Record<PlanSummaryDto["state"] | "none", string> = {
  awaiting_approval: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  planned: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  past: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  empty: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
  none: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/40",
};
const ERROR_KEYS: Record<string, UiTextKey> = {
  publishing_plan_changed: "weekPlan.error.changed",
  publishing_plan_slot_past: "weekPlan.error.past",
  publishing_plan_slot_vetoed: "weekPlan.error.vetoed",
  publishing_plan_slot_not_packaged: "weekPlan.error.notPackaged",
  publishing_plan_slot_too_soon: "weekPlan.retime.error.tooSoon",
  publishing_plan_already_published: "weekTemplate.move.error.published",
  publishing_plan_move_not_here: "weekTemplate.move.error.notHere",
  publishing_plan_move_youtube_unavailable: "weekTemplate.move.error.switches",
  publishing_plan_move_youtube_failed: "weekTemplate.move.error.youtubeFailed",
  publishing_plan_move_upload_active: "weekTemplate.move.error.uploadActive",
};
// BL-256: why a new day/time was refused (`validation_failed`, `details.refused[].reason`).
const RETIME_REASON_KEYS: Record<string, UiTextKey> = {
  outside_week: "weekPlan.retime.error.outsideWeek",
  in_past: "weekPlan.retime.error.tooSoon",
  publish_at_invalid: "weekPlan.retime.error.noSuchTime",
  date_invalid: "weekPlan.retime.error.noSuchTime",
  date_mismatch: "weekPlan.retime.error.noSuchTime",
  beyond_horizon: "weekTemplate.move.error.beyond",
  week_start_not_monday: "weekPlan.retime.error.noSuchTime",
  too_many_slots: "weekTemplate.move.error.full",
};

/** The slot's channel time reads the same on the owner's clock (same date and time). */
function sameClock(slot: Pick<PlanSlotDto, "date" | "publishAt" | "publishAtUtc">, ownerZone: string | null): boolean {
  const owner = zonedParts(slot.publishAtUtc, ownerZone);
  return owner.ymd === slot.date && owner.time === slot.publishAt.slice(11, 16);
}

const weekdayKey = (n: number) => `weekPlan.weekday.${n}` as UiTextKey;
const actorKey = (actor: "factory" | "worker" | "owner" | "producer", capital = false) => (capital ? `weekPlan.actorCap.${actor}` : `weekPlan.actor.${actor}`) as UiTextKey;

export function WeeklyPlanPanel({
  channelId,
  visible,
  uploads,
  packages,
  onPackagingChanged,
}: {
  channelId: string | null;
  visible: boolean;
  /** BL-266: this channel's uploads not over yet, by video number -- the slot card's percent (from «План»'s queue line). */
  uploads?: ReadonlyMap<string, ActiveUpload>;
  /** BL-266: the package scan rows by manifest hash -- an uploaded package's packaging and captions actions on its card. */
  packages?: ReadonlyMap<string, PlanPackageRow>;
  onPackagingChanged?: () => void;
}) {
  const t = useT();
  const { language } = useUiText();
  const ownerZone = useUserTimezone();
  const [summaries, setSummaries] = useState<PlanSummaryDto[] | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  // Owner TG 4784: the read week, always with the week it is for -- a plan (with BL-235's coverage: what YouTube has for that week,
  // null when unknown) or «none» (404). The screen shows it only while that week is the selected one.
  const [loaded, setLoaded] = useState<{ week: string; plan: PlanDto | "none"; coverage: WeekCoverageDto | null } | null>(null);
  // Owner TG 4784: the owner moved off the week the screen opened on (arrows, a move, a `?week=` link) -- then the opening week is
  // never recomputed under him.
  const navigated = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mode: Mode = "one";
  const [view, setView] = useState<View>("week");
  // BL-267: the week template (ghost rows of free positions); null until read or when unreadable.
  const [template, setTemplate] = useState<TemplateAnswerDto | null>(null);
  // BL-267 (AC-WT-27/28): «Дать дату вне шаблона» waits for its dialog.
  const [confirmDate, setConfirmDate] = useState<PlanSlotDto | null>(null);
  const [confirmVeto, setConfirmVeto] = useState<string | null>(null);
  // BL-256: the slot whose day/time editor is open (one at a time).
  const [editing, setEditing] = useState<string | null>(null);
  // BL-256: the clock «Изменить время» is offered by (read outside render, refreshed every 30 s and with each plan read).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [loaded]);
  // BL-240 (A): pulled slots sit under one closed row; opening it is for this visit only.
  const [showVetoed, setShowVetoed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => setView(readView()), []);
  const chooseView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // A private window or blocked storage: the choice lasts for this page only.
    }
  };

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/publishing-plans` : null;

  const loadList = useCallback(async () => {
    if (!base) return;
    // BL-267: the template, for the week's ghost rows (a failed read just shows none) -- read beside the list, not after it.
    void fetch(`${base}/template`)
      .then((r) => (r.ok ? (r.json() as Promise<TemplateAnswerDto>) : null))
      .then((answer) => setTemplate(answer))
      .catch(() => setTemplate(null));
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { plans: PlanSummaryDto[] };
      setSummaries(body.plans);
      setError(null);
    } catch {
      setError(t("weekPlan.loadFailed"));
    }
  }, [base, t]);

  // Owner TG 4784 (the view broke when switching weeks): one week read at a time -- the read before is aborted, and an older week's
  // answer arriving late is dropped instead of replacing the selected week (which left the screen empty until the next minute).
  const loader = useRef<ReturnType<typeof createWeekLoader<{ plan: PlanDto; coverage: WeekCoverageDto | null } | "none">> | null>(null);
  useEffect(() => {
    if (!base) return;
    const current = createWeekLoader<{ plan: PlanDto; coverage: WeekCoverageDto | null } | "none">({
      fetchWeek: async (w, signal) => {
        const res = await fetch(`${base}/${w}`, { signal });
        if (res.status === 404) return "none";
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { plan: PlanDto; coverage?: WeekCoverageDto | null };
        return { plan: body.plan, coverage: body.coverage ?? null };
      },
      apply: (w, answer) => {
        setLoaded(answer === "none" ? { week: w, plan: "none", coverage: null } : { week: w, plan: answer.plan, coverage: answer.coverage });
        setError(null);
      },
      fail: () => setError(t("weekPlan.loadFailed")),
    });
    loader.current = current;
    return () => {
      current.cancel();
      if (loader.current === current) loader.current = null;
    };
  }, [base, t]);
  const weekRef = useRef(week);
  useEffect(() => {
    weekRef.current = week;
  }, [week]);
  const loadPlan = useCallback(async (which?: string, fresh = false) => {
    const w = which ?? weekRef.current;
    if (w) await loader.current?.load(w, { fresh });
  }, []);

  // Owner TG 4784: each time the tab opens, the current week -- in the channel's zone once the plans are read (the owner's own zone,
  // else the browser's, until then); a deliberate `?week=` link keeps its week. The week is known at once, so the week's read runs
  // beside the list's instead of waiting for it.
  const zoneRef = useRef<string | null>(null);
  useEffect(() => {
    zoneRef.current = channelZoneOf(summaries ?? []) ?? ownerZone;
  }, [summaries, ownerZone]);
  useEffect(() => {
    if (!visible) return;
    const linked = weekFromSearch(window.location.search);
    navigated.current = linked !== null;
    setWeek(linked ?? currentWeekStart(new Date().toISOString(), zoneRef.current));
  }, [visible, channelId]);
  // The plans (the channel's zone) or the owner's zone arrived, or a minute passed into a new week: the opening week follows them
  // while the owner has not moved off it.
  useEffect(() => {
    if (!visible || navigated.current) return;
    setWeek(currentWeekStart(new Date().toISOString(), channelZoneOf(summaries ?? []) ?? ownerZone));
  }, [visible, summaries, ownerZone]);
  const goToWeek = (next: string) => {
    navigated.current = true;
    setWeek(next);
  };

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
    void loadPlan(week);
    const id = setInterval(() => void loadPlan(week), 60_000);
    return () => clearInterval(id);
  }, [visible, week, loadPlan, base]);

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
        await loadPlan(undefined, true);
        return;
      }
      // Applied only while its week is still the shown one (the owner may have switched weeks during the save).
      if (body.plan && body.plan.weekStart === weekRef.current) {
        // The decision's own answer is newer than any read still in flight: that one is dropped.
        const decided = body.plan;
        loader.current?.cancel();
        setLoaded((current) => ({ week: decided.weekStart, plan: decided, coverage: current?.week === decided.weekStart ? current.coverage : null }));
      }
      setConfirmVeto(null);
      void loadList();
    } catch {
      setActionError(t("weekPlan.error.generic", { code: "network" }));
    } finally {
      setBusy(null);
    }
  }

  /**
   * BL-267 (ADR 0073 §5, plan §3.7; owner 4630/4636): the owner moves a slot anywhere -- `dryRun` first (what would change, also on
   * YouTube), then the move itself after his confirmation. A dated video's date moves on YouTube at once.
   */
  async function move(slot: PlanSlotDto, shownHash: string, toWeekStart: string, date: string, time: string, dryRun: boolean): Promise<MoveAnswer | null> {
    if (!base) return null;
    setBusy(`move:${slot.slotId}`);
    setActionError(null);
    try {
      const res = await fetch(`${base}/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotId: slot.slotId, contentHash: shownHash, toWeekStart, date, publishAt: `${date}T${time}`, dryRun }),
      });
      const body = (await res.json().catch(() => ({}))) as MoveAnswer & { error?: string; details?: { refused?: Array<{ reason: string }> } };
      if (!res.ok) {
        const reason = body.details?.refused?.[0]?.reason;
        const key = (reason ? RETIME_REASON_KEYS[reason] : undefined) ?? (body.error ? ERROR_KEYS[body.error] : undefined);
        setActionError(key ? t(key) : t("weekPlan.error.generic", { code: reason ?? body.error ?? String(res.status) }));
        await loadPlan(undefined, true);
        return null;
      }
      if (!dryRun) {
        if (body.youtube?.result === "failed") setActionError(t("weekTemplate.move.youtubeFailed", { reason: body.youtube.reason ?? "?" }));
        setEditing(null);
        // The plan follows the slot to its week (read here for that week -- never the old closure's).
        if (body.to.weekStart !== week) goToWeek(body.to.weekStart);
        await Promise.all([loadPlan(body.to.weekStart, true), loadList()]);
      }
      return body;
    } catch {
      setActionError(t("weekPlan.error.generic", { code: "network" }));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const shown = loaded && loaded.week === week && loaded.plan !== "none" && loaded.plan.weekStart === week ? loaded.plan : null;
  const coverage = shown && loaded?.coverage ? loaded.coverage : null;
  // Owner TG 4784: the selected week is not read yet (the open, a switch) -- a skeleton, never an empty or another week's body.
  const weekLoading = week !== null && loaded?.week !== week;
  const ghosts = useMemo(() => (shown && template?.template && nowMs > 0 ? freePositions(template.template.days, shown.weekStart, shown.slots, nowMs) : []), [shown, template, nowMs]);
  // The owner's own time is shown only where it differs from the channel's (also when his zone is unknown and the browser's is used).
  const sameZone = shown ? shown.slots.every((s) => sameClock(s, ownerZone)) : true;

  if (!channelId) return null;

  const renderRow = (slot: PlanSlotDto, number: number) =>
    shown ? (
      <SlotRow
        key={slot.slotId}
        channelId={channelId}
        slot={slot}
        number={number}
        plan={shown}
        mode={mode}
        ownerZone={ownerZone}
        zoneOf={(week) => (week === shown.weekStart ? shown.timeZone : summaries?.find((p) => p.weekStart === week)?.timeZone ?? null)}
        at={at}
        busy={busy}
        confirming={confirmVeto === slot.slotId}
        onAskVeto={() => setConfirmVeto(slot.slotId)}
        onCancelVeto={() => setConfirmVeto(null)}
        onDecide={decide}
        nowMs={nowMs}
        editing={editing === slot.slotId}
        onAskEdit={() => {
          setConfirmVeto(null);
          setEditing(slot.slotId);
        }}
        onCancelEdit={() => setEditing(null)}
        onMove={(shownHash, toWeekStart, date, time, dryRun) => move(slot, shownHash, toWeekStart, date, time, dryRun)}
        onAskDate={() => setConfirmDate(slot)}
        upload={slot.package ? (uploads?.get(slot.package.video) ?? null) : null}
        scanned={slot.package?.manifestSha256 ? (packages?.get(slot.package.manifestSha256) ?? null) : null}
        onPackagingChanged={onPackagingChanged}
      />
    ) : null;

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
  const units = estimateUploadUnits({ playlist: true, deferredPublishAt: true });
  const groups = shown ? splitVetoed(shown.slots) : { live: [], vetoed: [] };
  const weekCoverage = coverage ? weekCoverageLine(coverage) : null;
  const dayLabel = (date: string) => new Intl.DateTimeFormat(language, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));

  const viewSwitch = (
    <div className="inline-flex rounded-lg border border-zinc-700 bg-zinc-950 p-0.5" role="group" aria-label={t("weekTemplate.view.label")}>
      {(["week", "month", "template"] as const).map((value) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => chooseView(value)} className={`rounded-md px-3 py-1 text-sm transition-colors ${view === value ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-300 hover:text-white"}`}>
          {t(value === "week" ? "weekTemplate.view.week" : value === "month" ? "weekTemplate.view.month" : "weekTemplate.view.template")}
        </button>
      ))}
    </div>
  );
  if (view === "month")
    return (
      <div className="space-y-3">
        {viewSwitch}
        <PublishingCalendar channelId={channelId} visible={visible} />
      </div>
    );
  if (view === "template")
    return (
      <div className="space-y-3">
        {viewSwitch}
        <WeekTemplateEditor channelId={channelId} visible={visible} />
      </div>
    );

  return (
    <div className="space-y-3">
    {viewSwitch}
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      {/* Week header: arrows, the range, the state. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => week && goToWeek(shiftWeek(week, -1))} disabled={!week} aria-label={t("weekPlan.prevWeek")} title={t("weekPlan.prevWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ‹
          </button>
          <h2 className="text-lg font-semibold text-zinc-100">{week ? rangeLabel(week) : t("weekPlan.none")}</h2>
          <button type="button" onClick={() => week && goToWeek(shiftWeek(week, 1))} disabled={!week} aria-label={t("weekPlan.nextWeek")} title={t("weekPlan.nextWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ›
          </button>
          {week && <span className={`ml-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${stateStyle}`}>{t(stateKey)}</span>}
        </div>
      </div>

      {error && <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}
      {weekLoading && !error && <SkeletonLines lines={4} />}

      {shown && (
        <p className="text-sm text-zinc-500">
          {t(sameZone ? "weekPlan.captionSameZone" : "weekPlan.caption", { actor: t(actorKey(shown.updatedBy)), at: at(shown.updatedAt), zone: shown.timeZone })}
        </p>
      )}

      {week && loaded?.week === week && loaded.plan === "none" && <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-400">{t("weekPlan.noPlan")}</p>}

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

          {weekCoverage && (
            // BL-235 (owner msg 3806): the truth on YouTube next to the approvals -- a day is closed when a video is scheduled or
            // published on it with every tracked translation. It decides nothing here.
            <p
              title={t("weekPlan.coverage.hint", { time: coverage?.asOf ? at(coverage.asOf) : t("weekPlan.coverage.never") })}
              className={`rounded-lg border px-4 py-2 text-sm ${weekCoverage.covered === weekCoverage.total ? "border-emerald-900 bg-emerald-950/30 text-emerald-200" : "border-yellow-800/70 bg-yellow-950/20 text-zinc-200"}`}
            >
              <span className="font-medium">{t("weekPlan.coverage.closed", { covered: weekCoverage.covered, total: weekCoverage.total })}</span>
              {weekCoverage.gaps.length > 0 && <span> · {t("weekPlan.coverage.gaps", { days: weekCoverage.gaps.map(dayLabel).join(", ") })}</span>}
              {weekCoverage.missing.length > 0 && (
                <span>
                  {" "}
                  · {t("weekPlan.coverage.missing", { days: weekCoverage.missing.map((m) => `${dayLabel(m.date)} (${m.languages.join(", ")})`).join(", ") })}
                </span>
              )}
            </p>
          )}

          {actionError && <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">{actionError}</p>}

          {shown.slots.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-700 px-4 py-6 text-center text-sm text-zinc-400">{t("weekPlan.emptyPlan")}</p>
          ) : (
            <div className="@container space-y-2">
              {groups.live.length > 0 && (
                <ul className={`divide-y divide-zinc-800 overflow-hidden rounded-lg border border-zinc-800 ${ROWS_GRID}`}>
                  <ColumnSizer />
                  {groups.live.map(({ slot, number }) => renderRow(slot, number))}
                </ul>
              )}
              {groups.vetoed.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-zinc-800">
                  <button
                    type="button"
                    aria-expanded={showVetoed}
                    onClick={() => setShowVetoed((open) => !open)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-zinc-400 hover:bg-zinc-800/60"
                  >
                    <span>{t(showVetoed ? "weekPlan.vetoedGroup.hide" : "weekPlan.vetoedGroup.show", { count: groups.vetoed.length })}</span>
                    <span aria-hidden>{showVetoed ? "▴" : "▾"}</span>
                  </button>
                  {showVetoed && (
                    <ul className={`divide-y divide-zinc-800 border-t border-zinc-800 ${ROWS_GRID}`}>
                      <ColumnSizer />
                      {groups.vetoed.map(({ slot, number }) => renderRow(slot, number))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}

          {ghosts.length > 0 && (
            // BL-267 (AC-WT-30): the template's free positions this week -- nothing is dated there until a slot takes one.
            <ul className="divide-y divide-zinc-800/70 overflow-hidden rounded-lg border border-dashed border-zinc-700">
              {ghosts.map((g) => {
                const p = localAndUtc(g.instantUtc, ownerZone);
                return (
                  <li key={`${g.date}|${g.index}`} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm text-zinc-500">
                    <span className="w-28">{dayLabel(p.localYmd)}</span>
                    <span>{t("weekTemplate.time", { local: p.local, utc: p.utc })}</span>
                    <span>{t(g.entry.kind === "short" ? "weekTemplate.ghost.short" : g.entry.hours !== undefined ? "weekTemplate.ghost.longHours" : "weekTemplate.ghost.long", { hours: g.entry.hours ?? 0 })}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {confirmDate && (
        // BL-267 (AC-WT-27/28): one slot's explicit date, with exactly what it gives on YouTube.
        <ConfirmDialog
          title={t("weekTemplate.date.title")}
          description={(() => {
            const p = localAndUtc(confirmDate.publishAtUtc, ownerZone);
            return t(confirmDate.videoId ? "weekTemplate.date.textUploaded" : "weekTemplate.date.text", { day: dayLabel(p.localYmd), local: p.local, utc: p.utc, zone: shown?.timeZone ?? "", units });
          })()}
          confirmLabel={t("weekTemplate.date.confirm")}
          confirmBusyLabel={busy === `approve:${confirmDate.slotId}` ? t("weekPlan.action.saving") : null}
          onCancel={() => setConfirmDate(null)}
          onConfirm={() => void decide("approve", [{ slotId: confirmDate.slotId, contentHash: confirmDate.contentHash }], `approve:${confirmDate.slotId}`).then(() => setConfirmDate(null))}
        />
      )}
    </section>
    </div>
  );
}

/** BL-240: a replaced (or replacing) slot as the screen names it -- its day and time in the channel's zone, and its video. */
function replacedLabel(t: ReturnType<typeof useT>, slot: { publishAt: string | null; video: string | null; slotId: string }): string {
  if (!slot.publishAt) return slot.slotId;
  const wall = wallParts(slot.publishAt);
  const when = t("weekPlan.slotDay", { weekday: t(weekdayKey(wall.weekday)), day: `${wall.day} ${wall.time}` });
  return slot.video ? t("weekPlan.replaces.slotVideo", { when, video: slot.video }) : when;
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
  /** Review #9: an existing week's zone (a move's time is read in the TARGET week's zone; a new week takes the source plan's). */
  zoneOf: (weekStart: string) => string | null;
  at: (iso: string) => string;
  busy: string | null;
  confirming: boolean;
  onAskVeto: () => void;
  onCancelVeto: () => void;
  onDecide: (action: "approve" | "revoke" | "veto" | "restore", slots: Array<{ slotId: string; contentHash?: string }>, busyKey: string) => Promise<void>;
  nowMs: number;
  editing: boolean;
  onAskEdit: () => void;
  onCancelEdit: () => void;
  onMove: (shownHash: string, toWeekStart: string, date: string, time: string, dryRun: boolean) => Promise<MoveAnswer | null>;
  onAskDate: () => void;
  /** BL-266: the slot's video upload not over yet (status and percent), else null. */
  upload: ActiveUpload | null;
  /** BL-266: the slot package's scan row (packaging and captions actions once uploaded), else null. */
  scanned: PlanPackageRow | null;
  onPackagingChanged?: () => void;
}) {
  const t = useT();
  const { slot, plan, mode, at } = props;
  const wall = wallParts(slot.publishAt);
  const owner = zonedParts(slot.publishAtUtc, props.ownerZone);
  // BL-267 (O6): the day and the time both in the owner's zone (UTC beside the time, the channel's time on hover).
  const dayLabel = t("weekPlan.slotDay", { weekday: t(weekdayKey(owner.weekday)), day: owner.day });
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
        // BL-257: the owner's own package review is not a problem for the factory (shown as the status line instead).
        ...(ownerReviewOf(pkg).factoryProblems.length > 0 ? [t("weekPlan.package.problems", { count: ownerReviewOf(pkg).factoryProblems.length })] : []),
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
  const replacer = slot.vetoed?.replacedBy ? plan.slots.find((s) => s.slotId === slot.vetoed!.replacedBy) : undefined;
  if (slot.vetoed?.replacedBy)
    meta = {
      text: t("weekPlan.replacedBy", { slot: replacer ? replacedLabel(t, { publishAt: replacer.publishAt, video: replacer.package?.video ?? null, slotId: replacer.slotId }) : slot.vetoed.replacedBy, at: at(slot.vetoed.at) }),
      tone: "text-red-300/80",
    };
  else if (slot.vetoed) meta = { text: t("weekPlan.vetoed", { at: at(slot.vetoed.at) }), tone: "text-red-300/80" };
  else if (changed && slot.changedAfterApproval) {
    const previous = slot.changedAfterApproval.previous;
    const was =
      changed === "time"
        ? previous.date === slot.date
          ? previous.publishAt.slice(11, 16)
          : t("weekPlan.slotDay", { weekday: t(weekdayKey(wallParts(previous.publishAt).weekday)), day: `${wallParts(previous.publishAt).day} ${wallParts(previous.publishAt).time}` })
        : changed === "length"
          ? (previous.lengthHint ?? t("weekPlan.none"))
          : changed === "package"
            ? (previous.package?.video ?? t("weekPlan.none"))
            : previous.timeZone;
    const actor = t(actorKey(slot.changedAfterApproval.changedBy, true));
    const key = ({ time: "weekPlan.changed.time", length: "weekPlan.changed.length", note: "weekPlan.changed.note", zone: "weekPlan.changed.zone", package: "weekPlan.changed.package" } as const)[changed];
    meta = { text: t(key, { actor, at: at(slot.changedAfterApproval.changedAt), was }), tone: "text-amber-300" };
  } else if (deletedOnYoutube(slot)) meta = { text: t("weekPlan.deletedOnYoutube"), tone: "text-red-300" };
  else if (slot.status === "failed") meta = { text: t("weekPlan.failed", { code: slot.statusCode ?? "?" }), tone: "text-red-300" };
  else if (slot.released) meta = { text: t("weekPlan.released"), tone: "text-zinc-500" };
  // BL-257 (ADR 0070, AC-PR-14): the package waits for the owner's review in Media, or he returned it -- checked before "approved"
  // (review L4: a slot approved before the gate was switched on still waits for the review) and before "waiting for its package".
  else if (ownerReviewOf(pkg).review === "pending") meta = { text: t("weekPlan.awaitingOwnerReview"), tone: "text-amber-300" };
  else if (ownerReviewOf(pkg).review === "returned") meta = { text: t("weekPlan.ownerReviewReturned", { comment: ownerReviewOf(pkg).comment ?? "" }), tone: "text-red-300/90" };
  else if (slot.approval === "approved") meta = { text: t("weekPlan.approved", { at: at(slot.approvedAt ?? slot.updatedAt) }), tone: "text-emerald-300" };
  // BL-242: nothing to approve until the package is ready -- a short status, no button.
  else if (slot.approval === "awaiting_package") meta = { text: t("weekPlan.awaitingPackage"), tone: "text-sky-300/80" };
  // BL-267: a slot the template dates says so in its dating chip (below), not «не одобрен».
  else if (slot.dating) meta = { text: "", tone: "text-zinc-400" };
  else if (mode === "one") meta = { text: t("weekPlan.notApproved"), tone: "text-zinc-400" };
  else meta = { text: slot.note ? t("weekPlan.agentNote", { note: slot.note }) : "", tone: "text-zinc-400" };

  const canAct = !slot.released;
  // The video may already be on YouTube: under way, scheduled, published, or uploaded private without a date (it has a video id).
  // BL-243: a video deleted on YouTube is not there any more (its id is kept only to show which one it was).
  const afterUpload = !deletedOnYoutube(slot) && (slot.videoId !== null || slot.status === "uploading" || slot.status === "scheduled" || slot.status === "published");

  // The buttons on the right, each by its own rule (restore and pull never together; revoke and the explicit date never together).
  const showThumb = slot.videoId !== null && !deletedOnYoutube(slot);
  const showRestore = canAct && slot.vetoed !== null;
  const showRevoke = canAct && !slot.vetoed && mode === "one" && slot.approval === "approved";
  const showDate = canAct && mode === "one" && canApprove(slot) && slot.dating?.source !== "template";
  const showRetime = props.nowMs > 0 && canRetime(slot, props.nowMs) && !props.editing;
  const showVeto = canAct && !slot.vetoed;

  return (
    <li className={`${ROW_ITEM} ${changed ? "bg-amber-950/20" : slot.vetoed ? "bg-zinc-950/40" : ""}`}>
      <div className={ROW_MAIN}>
        {/* On a phone the day and time take the whole line (the thumbnail column is hidden there). */}
        <div className={`col-span-2 @min-[44rem]:col-span-1 ${slot.vetoed ? "text-zinc-500" : "text-zinc-100"}`}>
          <div className={`text-sm font-medium ${slot.vetoed ? "line-through" : ""}`}>{dayLabel}</div>
          {/* BL-267 (O6, AC-WT-43): the owner's own time with UTC beside it; the channel's time on hover. */}
          <div className="text-sm" title={t("weekTemplate.channelTime", { time: wall.time, zone: plan.timeZone })}>
            {t("weekTemplate.time", { local: owner.time, utc: localAndUtc(slot.publishAtUtc, props.ownerZone).utc })}
          </div>
        </div>
        {pkg?.thumbnailPath ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local file served by the app's own route, not an optimisable asset
          <img
            src={`/api/channels/${encodeURIComponent(props.channelId)}/publishing/packages/thumbnail?path=${encodeURIComponent(pkg.thumbnailPath)}`}
            alt={pkg.title}
            className={`hidden h-[54px] w-24 rounded-md object-cover @min-[44rem]:block ${slot.vetoed ? "opacity-50" : ""}`}
          />
        ) : (
          <div className="hidden h-[54px] w-24 items-center justify-center rounded-md border border-dashed border-zinc-700 text-[10px] text-zinc-500 @min-[44rem]:flex">{t("weekPlan.noThumbnail")}</div>
        )}
        <div className="col-span-2 min-w-0 @min-[44rem]:col-span-1">
          <div className={`flex items-center gap-1.5 truncate text-sm font-medium ${slot.vetoed ? "text-zinc-500" : "text-zinc-100"}`}>
            {/* BL-259 (owner msg 4397): vertical (Shorts) or horizontal. */}
            <OrientationIcon orientation={pkg?.orientation} />
            {/* BL-260 (owner msg 4421): the video in a popup player -- the package's file here, else YouTube's player. */}
            <VideoPlayButton channelId={props.channelId} target={{ title, manifestSha256: pkg?.manifestSha256 ?? null, videoId: deletedOnYoutube(slot) ? null : slot.videoId }} />
            <span className="truncate">{title}</span>
          </div>
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
          {/* BL-267 (ADR 0073 §3): how the slot is dated -- by the template, by the owner's explicit date, or what it waits for. */}
          {slot.dating && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
              <span className={`rounded px-1.5 py-0.5 ring-1 ${DATING_STYLES[slot.dating.state]}`}>
                {t(DATING_KEYS[slot.dating.state], { slot: slot.dating.heldBy ?? "", at: slot.foreignPublishAt ? at(slot.foreignPublishAt) : "" })}
              </span>
              {slot.dating.source && slot.dating.state !== "vetoed" && <span className="text-zinc-500">{t(slot.dating.source === "template" ? "weekTemplate.source.template" : "weekTemplate.source.owner")}</span>}
              {slot.movedFrom && <span className="text-zinc-500">{t(slot.movedFrom.by === "producer" ? "weekTemplate.movedByProducer" : "weekTemplate.movedByOwner", { at: at(slot.movedFrom.at) })}</span>}
            </div>
          )}
          {/* BL-266: the slot's video is being uploaded from this computer -- its status and percent (the queue line has the list). */}
          {props.upload && (
            <div className="mt-0.5 text-xs">
              <span className="rounded bg-indigo-950/60 px-1.5 py-0.5 text-indigo-200">{t(`publishingUploads.status.${props.upload.status}` as UiTextKey, { percent: props.upload.percent })}</span>
            </div>
          )}
          {/* BL-242 R3: a date on YouTube no approval of this slot counts for -- approving moves it, vetoing removes it. */}
          {strayDateOf(slot) && <div className="truncate text-xs text-amber-300">{t("weekPlan.onYoutube", { at: at(strayDateOf(slot)!) })}</div>}
          {/* BL-242 round 3: two packages with one video number -- the uploads date neither. */}
          {duplicateWarningOf(slot) && <div className="truncate text-xs text-amber-300">{t("weekPlan.duplicateVideo")}</div>}
          {slot.replaces && !slot.vetoed && (
            <div className="truncate text-xs text-amber-300">
              {t(replacedToPull([slot]).length > 0 && slot.approval !== "approved" ? "weekPlan.replaces.willPull" : "weekPlan.replaces.done", { slot: replacedLabel(t, slot.replaces) })}
            </div>
          )}
        </div>
        <div className={ROW_CHAIN} aria-label={t("weekPlan.pipelineLabel")}>
          {pipeline ? <PipelineChain steps={pipeline} /> : <span className="text-zinc-600">{t("weekPlan.none")}</span>}
        </div>
        {(showThumb || showRestore || showRevoke || showDate || showRetime || showVeto) && (
        <div className={ROW_ACTIONS}>
          {/* BL-255 (ADR 0069): an uploaded video's thumbnail can be replaced on YouTube without touching the slot or its approval. */}
          {showThumb && slot.videoId !== null && <ThumbnailReplaceButton channelId={props.channelId} videoId={slot.videoId} videoNumber={pkg?.video ?? null} currentUrl={null} />}
          {showRestore && (
            <ActionButton busy={props.busy === `restore:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("restore", [{ slotId: slot.slotId }], `restore:${slot.slotId}`)} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weekPlan.action.restore")}
            </ActionButton>
          )}
          {showRevoke && (
            <ActionButton busy={props.busy === `revoke:${slot.slotId}`} busyLabel={t("weekPlan.action.saving")} disabled={anyBusy} onClick={() => void props.onDecide("revoke", [{ slotId: slot.slotId, contentHash: slot.contentHash }], `revoke:${slot.slotId}`)} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weekPlan.action.revoke")}
            </ActionButton>
          )}
          {/* BL-267 (AC-WT-27): the explicit one-slot date, only where the template gives none; behind a dialog. */}
          {showDate && (
            <button type="button" disabled={anyBusy} onClick={props.onAskDate} className="rounded-md bg-violet-600 px-3 py-1 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
              {t("weekTemplate.date.action")}
            </button>
          )}
          {/* BL-256: move the slot to another day of the week or another time (not within 15 minutes of its time). */}
          {showRetime && (
            <button type="button" disabled={anyBusy} onClick={props.onAskEdit} className="rounded-md border border-zinc-600 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
              {t("weekPlan.action.retime")}
            </button>
          )}
          {showVeto && (
            <button type="button" disabled={anyBusy || busyHere} onClick={props.onAskVeto} className="rounded-md border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-40">
              {t(mode === "one" ? "weekPlan.action.vetoShort" : "weekPlan.action.veto")}
            </button>
          )}
        </div>
        )}
      </div>
      <div className="@min-[44rem]:col-span-full">
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
      {props.editing && !slot.vetoed && (
        <MoveEditor slot={slot} plan={plan} ownerZone={props.ownerZone} zoneOf={props.zoneOf} busy={props.busy} onCancel={props.onCancelEdit} onMove={props.onMove} />
      )}
      {/* BL-266 (moved from «Ролики и релизы»; BL-265/BL-269): an uploaded package's packaging and captions actions, on its own card. */}
      {props.scanned && props.scanned.youtube && props.scanned.state !== "deleted_on_youtube" && props.scanned.manifestSha256 && props.scanned.video && (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2">
          <PackagingActions channelId={props.channelId} video={props.scanned.video} manifestSha256={props.scanned.manifestSha256} differs={props.scanned.youtubeTextsDiffer ?? null} onChanged={() => props.onPackagingChanged?.()} />
          {(props.scanned.pkg?.captions?.length ?? 0) > 0 && <CaptionsActions channelId={props.channelId} video={props.scanned.video} onChanged={() => props.onPackagingChanged?.()} />}
        </div>
      )}
      {pkg && <SlotSocialPreview channelId={props.channelId} video={pkg.video} manifestSha256={pkg.manifestSha256 ?? null} slotTime={wall.time} />}
      </div>
    </li>
  );
}

/** The step chain План › Видео › Пакет › YouTube › Дата (one width in a language, whatever the states). */
function PipelineChain({ steps }: { steps: ReadonlyArray<{ step: PipelineStep; state: PipelineStepState }> }) {
  const t = useT();
  return (
    <ol className="flex flex-wrap items-center gap-0.5 text-[11px] min-[400px]:gap-1 @min-[44rem]:flex-nowrap">
      {steps.map((s, i) => (
        <li key={s.step} className="flex items-center gap-0.5 whitespace-nowrap min-[400px]:gap-1">
          {i > 0 && <span aria-hidden className="text-zinc-600">›</span>}
          <span className={`rounded border px-1 py-0.5 min-[400px]:px-1.5 ${STEP_STYLES[s.state]}`}>{t(STEP_KEYS[s.step])}</span>
        </li>
      ))}
    </ol>
  );
}

const ALL_STEPS = (["plan", "video", "package", "youtube", "date"] as const).map((step) => ({ step, state: "todo" as const }));

/**
 * Owner TG 4784: the chain's column and the buttons' column take their width from the widest content they can ever hold -- not from
 * the rows of this week -- so the chain stands at the same place in every row and every week. An invisible first row of the list
 * (the rows share its columns through CSS subgrid) holds the full chain and, where the buttons have their own column, every
 * combination of buttons a row can show, in the current language, busy labels included.
 */
function ColumnSizer() {
  const t = useT();
  const plain = "whitespace-nowrap rounded-md border px-3 py-1 text-sm";
  const thumb = <span className={plain}>{t("thumbReplace.button")}</span>;
  const retime = <span className={plain}>{t("weekPlan.action.retime")}</span>;
  const veto = <span className={plain}>{t("weekPlan.action.vetoShort")}</span>;
  const saving = (
    <span className={plain}>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-3.5" />
        {t("weekPlan.action.saving")}
      </span>
    </span>
  );
  const combos: ReactNode[][] = [
    [thumb, <span key="r" className={plain}>{t("weekPlan.action.revoke")}</span>, retime, veto],
    [thumb, <span key="d" className={`${plain} font-semibold`}>{t("weekTemplate.date.action")}</span>, retime, veto],
    [thumb, saving, retime, veto],
    [thumb, <span key="s" className={plain}>{t("weekPlan.action.restore")}</span>, retime],
  ];
  return (
    <li aria-hidden className="invisible hidden h-0 overflow-hidden !border-0 @min-[44rem]:col-span-full @min-[44rem]:grid @min-[44rem]:grid-cols-subgrid">
      <div className="px-4 @min-[44rem]:col-span-full @min-[44rem]:grid @min-[44rem]:grid-cols-subgrid">
        <div className="@min-[44rem]:col-start-4">
          <PipelineChain steps={ALL_STEPS} />
        </div>
        <div className={SIZER_ACTIONS}>
          {combos.map((combo, i) => (
            <div key={i} className="flex flex-nowrap gap-2">
              {combo.map((button, j) => (
                <span key={j}>{button}</span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </li>
  );
}

/**
 * BL-267 (ADR 0073 §5, plan §3.7; owner 4630/4636): move a slot anywhere -- the week (arrows), one of its seven days and the time
 * (typed `HH:MM` in the plan's zone, never a native picker). «Проверить» asks the server what would change (dry run, also on YouTube);
 * the dialog then names from -> to in his own time and UTC and the YouTube effect, and only its button moves the slot.
 */
function MoveEditor(props: { slot: PlanSlotDto; plan: PlanDto; ownerZone: string | null; zoneOf: (weekStart: string) => string | null; busy: string | null; onCancel: () => void; onMove: (shownHash: string, toWeekStart: string, date: string, time: string, dryRun: boolean) => Promise<MoveAnswer | null> }) {
  const t = useT();
  const { slot, plan } = props;
  const [shownHash] = useState(slot.contentHash);
  const [weekStart, setWeekStart] = useState(plan.weekStart);
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.publishAt.slice(11, 16));
  const [preview, setPreview] = useState<MoveAnswer | null>(null);
  const clock = parseClock(time);
  const days = weekDays(weekStart);
  const day = days.includes(date) ? date : days[0];
  const samePlace = clock !== null && day === slot.date && clock === slot.publishAt.slice(11, 16) && weekStart === plan.weekStart;
  // Review #2: the same place again retries the YouTube write when the video's date differs from the slot's time.
  const youtubeDiffers = typeof slot.youtubePublishAt === "string" && Date.parse(slot.youtubePublishAt) !== Date.parse(slot.publishAtUtc);
  const unchanged = samePlace && !youtubeDiffers;
  // Review #9: the server reads the time in the target week's zone (an existing week's own, else this plan's).
  const targetZone = props.zoneOf(weekStart) ?? plan.timeZone;
  const anyBusy = props.busy !== null;
  const shift = (n: number) => {
    const next = shiftWeek(weekStart, n);
    setWeekStart(next);
    setDate(weekDays(next)[weekDays(weekStart).indexOf(day)] ?? weekDays(next)[0]);
  };
  const both = (iso: string) => {
    const p = localAndUtc(iso, props.ownerZone);
    return t("weekTemplate.move.when", { day: p.localYmd, local: p.local, utc: p.utc });
  };
  return (
    <div className="space-y-2 border-t border-zinc-700 bg-zinc-950/60 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1 text-xs text-zinc-400">
          <button type="button" onClick={() => shift(-1)} disabled={anyBusy} aria-label={t("weekPlan.prevWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ‹
          </button>
          <span className="px-1">{t("weekTemplate.move.week", { week: weekStart })}</span>
          <button type="button" onClick={() => shift(1)} disabled={anyBusy} aria-label={t("weekPlan.nextWeek")} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            ›
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("weekPlan.retime.day")}
          <select value={day} onChange={(e) => setDate(e.target.value)} disabled={anyBusy} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100">
            {days.map((d) => {
              const wall = wallParts(`${d}T00:00`);
              return (
                <option key={d} value={d}>
                  {t("weekPlan.slotDay", { weekday: t(weekdayKey(wall.weekday)), day: wall.day })}
                </option>
              );
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("weekPlan.retime.time", { zone: targetZone })}
          <input type="text" inputMode="numeric" value={time} onChange={(e) => setTime(e.target.value)} disabled={anyBusy} placeholder="18:00" aria-invalid={clock === null} className={`w-24 rounded-md border bg-zinc-900 px-2 py-1 text-sm text-zinc-100 ${clock === null ? "border-red-700" : "border-zinc-700"}`} />
        </label>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            busy={props.busy === `move:${slot.slotId}` && preview === null}
            busyLabel={t("weekPlan.action.saving")}
            disabled={anyBusy || clock === null || unchanged}
            onClick={() => void props.onMove(shownHash, weekStart, day, clock!, true).then((answer) => setPreview(answer))}
            className="rounded-md bg-violet-600 px-3 py-1 font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {t("weekTemplate.move.check")}
          </ActionButton>
          <button type="button" onClick={props.onCancel} disabled={anyBusy} className="rounded-md px-3 py-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-40">
            {t("weekPlan.confirm.cancel")}
          </button>
        </div>
      </div>
      {clock === null && <p className="text-xs text-red-300">{t("weekPlan.retime.badTime")}</p>}
      <p className="text-xs text-zinc-500">{t("weekTemplate.move.hint")}</p>
      {preview && (
        <ConfirmDialog
          title={t("weekTemplate.move.title", { video: slot.package?.video ?? slot.slotId })}
          description={t("weekTemplate.move.fromTo", { from: both(preview.from.publishAtUtc), to: both(preview.to.publishAtUtc) })}
          confirmLabel={t("weekTemplate.move.confirm", { to: both(preview.to.publishAtUtc) })}
          confirmBusyLabel={props.busy === `move:${slot.slotId}` ? t("weekPlan.action.saving") : null}
          onCancel={() => setPreview(null)}
          onConfirm={() => void props.onMove(shownHash, weekStart, day, clock!, false).then(() => setPreview(null))}
        >
          <p className="text-sm text-zinc-300">
            {preview.youtube.effect === "moves"
              ? t("weekTemplate.move.effect.moves", { from: preview.youtube.previous ? both(preview.youtube.previous) : "", to: both(preview.to.publishAtUtc) })
              : preview.youtube.effect === "plan_only"
                ? t("weekTemplate.move.effect.planOnly")
                : t("weekTemplate.move.effect.none")}
          </p>
          {(preview.displaces ?? []).map((d) => (
            <p key={d.slotId} className="text-sm text-amber-300">
              {t("weekTemplate.move.displaces", { video: d.video ?? d.slotId, when: both(d.publishAtUtc) })}
            </p>
          ))}
        </ConfirmDialog>
      )}
    </div>
  );
}
