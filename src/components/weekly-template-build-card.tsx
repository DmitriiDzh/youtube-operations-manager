"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import type { WeeklyBuildView, WeeklyTemplateCollect } from "@/lib/weekly-build/contracts";
import { ActionButton } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { useT } from "./ui-text-provider";
import { isMusicTemplateDto, type TemplateDto } from "./week-template-model";

// BL-267 (WEEK_TEMPLATE_PLAN.md §3.9, ADR 0073 §7; owner O7, agreed with the Operator): «Собрать неделю по шаблону» -- the former
// «Сборка недели» card. Shown when the channel's template in force is a music template (every entry a long video with hours), or
// when there is none (then the button is disabled); hidden when another template is in force (no channel names in code, §B). A done
// job's plan is saved here as the factory (the card asks the server once per job); refused weeks show their code.

const REFUSALS = new Set(["no_template", "week_has_plan", "outside_horizon", "job_running"]);

export function WeeklyTemplateBuildCard({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/weekly-build` : null;
  const [state, setState] = useState<{ inForce: boolean; music: boolean; template: TemplateDto | null } | null>(null);
  const [view, setView] = useState<WeeklyBuildView | null>(null);
  const [week, setWeek] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [collected, setCollected] = useState<WeeklyTemplateCollect | null>(null);

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const [s, v] = await Promise.all([fetch(`${base}/template`).then((r) => (r.ok ? r.json() : null)), fetch(base).then((r) => (r.ok ? r.json() : null))]);
      setState(s);
      setView(v);
      // A done template job: its payloads are saved once (the server remembers the job).
      if (v?.status?.job?.state === "done" && v.status.job.result) {
        const c = await fetch(`${base}/template/collect`, { method: "POST" }).then((r) => (r.ok ? r.json() : null));
        if (c?.collected) setCollected(c.collected as WeeklyTemplateCollect);
      }
    } catch {
      setState(null);
    }
  }, [base]);
  useEffect(() => {
    if (!visible) return;
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [visible, load]);

  if (!channelId || !state) return null;
  if (state.inForce && !isMusicTemplateDto(state.template)) return null;

  async function start() {
    if (!base) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${base}/template/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(week.trim() ? { week: week.trim() } : {}) });
      const body = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; details?: { code?: string } };
      if (!res.ok) {
        const code = body.details?.code;
        setNotice(code && REFUSALS.has(code) ? t(`weekTemplate.build.refused.${code}` as UiTextKey) : t("weekTemplate.build.failed", { code: body.error ?? String(res.status) }));
      } else setNotice(t("weekTemplate.build.started", { jobId: body.jobId ?? "?" }));
      setConfirm(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const slots = view?.status?.slots ?? [];
  const accepted = collected?.results.filter((r) => r.status === "accepted").length ?? 0;
  return (
    <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-zinc-100">{t("weekTemplate.build.title")}</h2>
      <p className="text-sm text-zinc-400">{t(state.inForce ? "weekTemplate.build.help" : "weekTemplate.build.noTemplate")}</p>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("weekTemplate.build.week")}
          <input type="text" value={week} placeholder="2026-11-23" disabled={busy || !state.inForce} onChange={(e) => setWeek(e.target.value)} className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100" />
        </label>
        <ActionButton busy={busy} busyLabel={t("weekTemplate.saving")} disabled={busy || !state.inForce || view?.readiness.ready === false} onClick={() => setConfirm(true)} className="rounded-md bg-violet-600 px-4 py-2 font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40">
          {t("weekTemplate.build.start")}
        </ActionButton>
        {view?.readiness.ready === false && <span className="text-xs text-amber-300">{view.readiness.message}</span>}
      </div>
      {notice && <p className="text-sm text-zinc-300">{notice}</p>}
      {collected && (
        <div className="space-y-1 text-sm">
          <p className="text-zinc-200">{t("weekTemplate.build.collected", { accepted, total: collected.results.length })}</p>
          {collected.results
            .filter((r) => r.status === "refused")
            .map((r) => (
              <p key={r.index} className="text-amber-300">
                {t("weekTemplate.build.refusedPayload", { week: r.weekStart ?? "?", code: r.code ?? "?" })}
              </p>
            ))}
          {collected.pushError && <p className="text-amber-300">{t("weekTemplate.build.pushFailed", { reason: collected.pushError })}</p>}
        </div>
      )}
      {slots.length > 0 && (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 text-sm">
          {slots.map((s) => (
            <li key={s.slotId} className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-zinc-300">
              <span className="w-28 text-zinc-400">{s.date}</span>
              <span className="truncate">{s.slotId}</span>
              <span className="ml-auto text-xs text-zinc-400">{s.video ?? (s.status === "planned" ? t("weekTemplate.build.waitingVideo") : s.status)}</span>
            </li>
          ))}
        </ul>
      )}
      {confirm && <ConfirmDialog title={t("weekTemplate.build.title")} description={t("weekTemplate.build.help")} confirmLabel={t("weekTemplate.build.start")} confirmBusyLabel={busy ? t("weekTemplate.saving") : null} onCancel={() => setConfirm(false)} onConfirm={() => void start()} />}
    </section>
  );
}
