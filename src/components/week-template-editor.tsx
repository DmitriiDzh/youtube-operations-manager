"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { ActionButton, SkeletonLines } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";
import { useUserTimezone } from "./use-user-timezone";
import { TEMPLATE_DAYS, emptyTemplate, entryInstant, localAndUtc, parseTemplateTime, sortEntries, templateDiff, type TemplateAnswerDto, type TemplateDay, type TemplateDto, type TemplateEntryDto } from "./week-template-model";

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.3/§3.9, ADR 0073 §1; owner msgs 4569/4572/4575, O6): «План» → «Шаблон недели». The owner sets up
// which kinds of video come out on which UTC weekday at which UTC time, sees his own time beside each, accepts / rejects / opens the
// Producer's proposal, and applies an edit through a dialog that lists exactly what changes. «Даты по шаблону» off withdraws it.
// Times are typed `HH:MM` (never a native picker); the switch has a visible caption.

type Row = { kind: "long" | "short"; hours: string; time: string };
type Draft = { horizonWeeks: string; displayTimeZone: string; days: Record<TemplateDay, Row[]> };

const dayKey = (d: TemplateDay) => `weekTemplate.day.${d}` as UiTextKey;

function draftOf(t: TemplateDto): Draft {
  const days = Object.fromEntries(TEMPLATE_DAYS.map((d) => [d, sortEntries(t.days[d] ?? []).map((e) => ({ kind: e.kind, hours: e.hours !== undefined ? String(e.hours) : "", time: e.publishTimeUtc }))])) as Record<TemplateDay, Row[]>;
  return { horizonWeeks: String(t.horizonWeeks), displayTimeZone: t.displayTimeZone ?? "", days };
}

/** The draft as `week-template/1`, or the first problem (a key) when it is not one. */
function templateOf(channelId: string, draft: Draft): { ok: true; template: TemplateDto } | { ok: false; problem: UiTextKey } {
  const horizon = Number(draft.horizonWeeks);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 8) return { ok: false, problem: "weekTemplate.problem.horizon" };
  const days: TemplateDto["days"] = {};
  for (const d of TEMPLATE_DAYS) {
    const entries: TemplateEntryDto[] = [];
    for (const row of draft.days[d]) {
      const time = parseTemplateTime(row.time);
      if (!time) return { ok: false, problem: "weekTemplate.problem.time" };
      let hours: number | undefined;
      if (row.hours.trim() !== "") {
        hours = Number(row.hours.replace(",", "."));
        if (row.kind === "short" || !Number.isFinite(hours) || hours < 0.25 || hours > 12 || Math.round(hours * 4) !== hours * 4) return { ok: false, problem: "weekTemplate.problem.hours" };
      }
      entries.push({ kind: row.kind, ...(hours !== undefined ? { hours } : {}), publishTimeUtc: time });
    }
    if (entries.length > 6) return { ok: false, problem: "weekTemplate.problem.tooMany" };
    if (entries.length > 0) days[d] = entries;
  }
  return { ok: true, template: { format: "week-template/1", channelId, horizonWeeks: horizon, ...(draft.displayTimeZone.trim() ? { displayTimeZone: draft.displayTimeZone.trim() } : { displayTimeZone: null }), days } };
}

export function WeekTemplateEditor({ channelId, visible }: { channelId: string; visible: boolean }) {
  const t = useT();
  const ownerZone = useUserTimezone();
  const base = `/api/channels/${encodeURIComponent(channelId)}/publishing-plans/template`;
  const [answer, setAnswer] = useState<TemplateAnswerDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [basedOn, setBasedOn] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "apply"; template: TemplateDto } | { kind: "withdraw" } | { kind: "accept" | "reject"; proposal: TemplateDto }>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => setNowMs(Date.now()), [answer]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as TemplateAnswerDto;
      setAnswer(body);
      setDraft((current) => current ?? draftOf(body.template ?? emptyTemplate(channelId)));
      setError(null);
    } catch {
      setError(t("weekTemplate.loadFailed"));
    }
  }, [base, channelId, t]);
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const result = (await res.json().catch(() => ({}))) as TemplateAnswerDto & { error?: string; details?: { refused?: Array<{ field: string; reason: string }> } };
      if (!res.ok) {
        const refused = result.details?.refused?.map((r) => `${r.field}: ${r.reason}`).join("; ");
        setError(t("weekTemplate.saveFailed", { code: refused ?? result.error ?? String(res.status) }));
        return;
      }
      setAnswer(result);
      setDraft(draftOf(result.template ?? emptyTemplate(channelId)));
      setBasedOn(undefined);
      setConfirm(null);
    } catch {
      setError(t("weekTemplate.saveFailed", { code: "network" }));
    } finally {
      setBusy(false);
    }
  }

  if (!answer || !draft) return error ? <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p> : <SkeletonLines lines={4} />;
  const inForce = answer.template;
  const built = templateOf(channelId, draft);
  const diff = built.ok ? templateDiff(inForce, built.template) : [];
  const unchanged = built.ok && diff.length === 0 && inForce !== null && (inForce.horizonWeeks === built.template.horizonWeeks && (inForce.displayTimeZone ?? null) === (built.template.displayTimeZone ?? null));
  const setRows = (d: TemplateDay, rows: Row[]) => setDraft({ ...draft, days: { ...draft.days, [d]: rows } });
  const timeLine = (day: TemplateDay, time: string) => {
    const parsed = parseTemplateTime(time);
    if (!parsed || nowMs === 0) return null;
    const p = localAndUtc(entryInstant(day, parsed, nowMs), ownerZone);
    return t(p.dayShift === 0 ? "weekTemplate.localTime" : p.dayShift > 0 ? "weekTemplate.localTimeNextDay" : "weekTemplate.localTimePrevDay", { time: p.local });
  };

  return (
    <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">{t("weekTemplate.title")}</h2>
          <p className="text-sm text-zinc-400">{t("weekTemplate.help")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <ToggleSwitch tone="violet" checked={inForce !== null} disabled={busy || (inForce === null && !built.ok)} label={t("weekTemplate.toggle")} onChange={(on) => setConfirm(on && built.ok ? { kind: "apply", template: built.template } : { kind: "withdraw" })} />
          <span>{t("weekTemplate.toggle")}</span>
        </label>
      </div>
      <p className="text-xs text-zinc-500">{inForce ? t("weekTemplate.inForce", { by: t(inForce.by === "producer" ? "weekTemplate.by.producer" : "weekTemplate.by.owner") }) : t("weekTemplate.none")}</p>

      {answer.proposal && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-900 bg-sky-950/30 px-4 py-3 text-sm text-sky-100">
          <span>{t("weekTemplate.proposal")}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "accept", proposal: answer.proposal! })} className="rounded-md bg-violet-600 px-3 py-1 font-semibold text-white hover:bg-violet-500 disabled:opacity-40">
              {t("weekTemplate.proposal.accept")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(draftOf(answer.proposal!));
                setBasedOn(answer.proposal!.versionId);
              }}
              className="rounded-md border border-zinc-600 px-3 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              {t("weekTemplate.proposal.edit")}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "reject", proposal: answer.proposal! })} className="rounded-md border border-red-900 px-3 py-1 text-red-300 hover:bg-red-950/50 disabled:opacity-40">
              {t("weekTemplate.proposal.reject")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        {TEMPLATE_DAYS.map((d) => (
          <div key={d} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-100">{t(dayKey(d))}</span>
              <button type="button" disabled={busy || draft.days[d].length >= 6} onClick={() => setRows(d, [...draft.days[d], { kind: "long", hours: "", time: "12:00" }])} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                {t("weekTemplate.addEntry")}
              </button>
            </div>
            {draft.days[d].length === 0 && <p className="text-xs text-zinc-500">{t("weekTemplate.noEntries")}</p>}
            <ul className="space-y-2">
              {draft.days[d].map((row, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <select
                    aria-label={t("weekTemplate.kind")}
                    value={row.kind}
                    disabled={busy}
                    onChange={(e) => setRows(d, draft.days[d].map((r, j) => (j === i ? { ...r, kind: e.target.value as Row["kind"], hours: e.target.value === "short" ? "" : r.hours } : r)))}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                  >
                    <option value="long">{t("weekTemplate.kind.long")}</option>
                    <option value="short">{t("weekTemplate.kind.short")}</option>
                  </select>
                  {row.kind === "long" && (
                    <input type="text" inputMode="decimal" aria-label={t("weekTemplate.hours")} placeholder={t("weekTemplate.hoursPlaceholder")} value={row.hours} disabled={busy} onChange={(e) => setRows(d, draft.days[d].map((r, j) => (j === i ? { ...r, hours: e.target.value } : r)))} className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100" />
                  )}
                  <input type="text" inputMode="numeric" aria-label={t("weekTemplate.timeUtc")} value={row.time} disabled={busy} aria-invalid={parseTemplateTime(row.time) === null} onChange={(e) => setRows(d, draft.days[d].map((r, j) => (j === i ? { ...r, time: e.target.value } : r)))} className={`w-20 rounded-md border bg-zinc-900 px-2 py-1 text-zinc-100 ${parseTemplateTime(row.time) === null ? "border-red-700" : "border-zinc-700"}`} />
                  <span className="text-xs text-zinc-500">{t("weekTemplate.utc")}</span>
                  {timeLine(d, row.time) && <span className="text-xs text-zinc-400">{timeLine(d, row.time)}</span>}
                  <button type="button" disabled={busy} onClick={() => setRows(d, draft.days[d].filter((_, j) => j !== i))} aria-label={t("weekTemplate.removeEntry")} title={t("weekTemplate.removeEntry")} className="ml-auto rounded-md px-2 py-0.5 text-zinc-500 hover:text-red-300 disabled:opacity-40">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("weekTemplate.horizon")}
          <input type="text" inputMode="numeric" value={draft.horizonWeeks} disabled={busy} onChange={(e) => setDraft({ ...draft, horizonWeeks: e.target.value })} className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("weekTemplate.displayZone")}
          <input type="text" value={draft.displayTimeZone} disabled={busy} placeholder="Asia/Tokyo" onChange={(e) => setDraft({ ...draft, displayTimeZone: e.target.value })} className="w-44 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
        </label>
        <ActionButton
          busy={busy && confirm?.kind === "apply"}
          busyLabel={t("weekTemplate.saving")}
          disabled={busy || !built.ok || unchanged}
          onClick={() => built.ok && setConfirm({ kind: "apply", template: built.template })}
          className="rounded-md bg-violet-600 px-4 py-2 font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("weekTemplate.apply")}
        </ActionButton>
        {!built.ok && <span className="text-xs text-red-300">{t(built.problem)}</span>}
      </div>

      {confirm?.kind === "apply" && (
        <ConfirmDialog title={t("weekTemplate.confirm.applyTitle")} description={t("weekTemplate.confirm.applyText")} confirmLabel={t("weekTemplate.apply")} confirmBusyLabel={busy ? t("weekTemplate.saving") : null} onCancel={() => setConfirm(null)} onConfirm={() => void post("", { template: confirm.template, ...(basedOn ? { basedOn } : {}) })}>
          <DiffList before={inForce} after={confirm.template} />
          <EffectList base={base} template={confirm.template} ownerZone={ownerZone} />
        </ConfirmDialog>
      )}
      {confirm?.kind === "withdraw" && (
        <ConfirmDialog title={t("weekTemplate.confirm.withdrawTitle")} description={t("weekTemplate.confirm.withdrawText")} confirmLabel={t("weekTemplate.confirm.withdraw")} confirmVariant="danger" onCancel={() => setConfirm(null)} onConfirm={() => void post("/withdraw", {})} />
      )}
      {(confirm?.kind === "accept" || confirm?.kind === "reject") && (
        <ConfirmDialog
          title={t(confirm.kind === "accept" ? "weekTemplate.confirm.acceptTitle" : "weekTemplate.confirm.rejectTitle")}
          description={t(confirm.kind === "accept" ? "weekTemplate.confirm.applyText" : "weekTemplate.confirm.rejectText")}
          confirmLabel={t(confirm.kind === "accept" ? "weekTemplate.proposal.accept" : "weekTemplate.proposal.reject")}
          confirmVariant={confirm.kind === "reject" ? "danger" : "default"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void post("/decisions", { action: confirm.kind, versionId: confirm.proposal.versionId, contentHash: confirm.proposal.contentHash })}
        >
          <DiffList before={inForce} after={confirm.proposal} />
          {confirm.kind === "accept" && <EffectList base={base} template={confirm.proposal} ownerZone={ownerZone} />}
        </ConfirmDialog>
      )}
    </section>
  );
}

function DiffList({ before, after }: { before: TemplateDto | null; after: TemplateDto }) {
  const t = useT();
  const diff = templateDiff(before, after);
  if (diff.length === 0) return <p className="text-sm text-zinc-400">{t("weekTemplate.diff.none")}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {diff.map((d) => (
        <li key={d.day} className="text-zinc-200">
          <span className="font-medium">{t(dayKey(d.day))}</span>: {d.before.length ? d.before.join(", ") : t("weekTemplate.diff.empty")} → {d.after.length ? d.after.join(", ") : t("weekTemplate.diff.empty")} <span className="text-xs text-zinc-500">{t("weekTemplate.utc")}</span>
        </li>
      ))}
    </ul>
  );
}

type EffectSlot = { slotId: string; publishAtUtc: string; video: string | null; youtubePublishAt: string | null };

/** BL-267 (AC-WT-28): which slots the template would start or stop dating -- asked from the server when the dialog opens. */
function EffectList({ base, template, ownerZone }: { base: string; template: TemplateDto; ownerZone: string | null }) {
  const t = useT();
  const [effect, setEffect] = useState<{ gain: EffectSlot[]; lose: EffectSlot[] } | "failed" | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${base}/effect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ template }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => !cancelled && setEffect(body))
      .catch(() => !cancelled && setEffect("failed"));
    return () => {
      cancelled = true;
    };
  }, [base, template]);
  if (effect === null) return <p className="text-xs text-zinc-500">{t("weekTemplate.effect.loading")}</p>;
  if (effect === "failed") return <p className="text-xs text-amber-300">{t("weekTemplate.effect.failed")}</p>;
  const line = (s: EffectSlot) => {
    const p = localAndUtc(s.publishAtUtc, ownerZone);
    return `${s.video ?? s.slotId} · ${p.localYmd} ${p.local} (${p.utc} UTC)`;
  };
  return (
    <div className="mt-2 space-y-1 text-sm">
      <p className="text-zinc-200">{t("weekTemplate.effect.gain", { count: effect.gain.length })}</p>
      {effect.gain.map((s) => (
        <p key={s.slotId} className="text-xs text-emerald-300">
          {line(s)}
        </p>
      ))}
      <p className="text-zinc-200">{t("weekTemplate.effect.lose", { count: effect.lose.length })}</p>
      {effect.lose.map((s) => (
        <p key={s.slotId} className="text-xs text-amber-300">
          {line(s)}
        </p>
      ))}
    </div>
  );
}
