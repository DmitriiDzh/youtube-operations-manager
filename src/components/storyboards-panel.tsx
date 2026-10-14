"use client";

import { useCallback, useEffect, useState } from "react";
import type { StoryboardSummary } from "@/lib/storyboards";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { STATE_LABEL, STATE_TONE, sortForOwner } from "./storyboard-model";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-184 stage 1 (FO-REQ-0024 §4 A/B2): Media → «Раскадровка» -- the active channel's storyboards, what waits for the owner first.
// A row opens the storyboard's review screen at its own address. BL-184 stage 2 (B4, owner 1183): the channel's setting "a video
// from two different first and last frames only from an approved storyboard" sits on top, on by default.

const POLL_MS = 30_000;

export function StoryboardsPanel({ channelId, active, onOpen, onWaiting }: { channelId: string | null; active: boolean; onOpen: (storyboardId: string) => void; onWaiting?: (count: number) => void }) {
  const t = useT();
  const [list, setList] = useState<StoryboardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<{ requireApproved: boolean; changedAt: string | null; changedBy: string | null } | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => {
    if (!channelId) return;
    void fetch(`/api/channels/${encodeURIComponent(channelId)}/storyboards`)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorText(t, body, t("storyboards.loadFailed"), { showErrorField: false }));
        return body as { storyboards: StoryboardSummary[] };
      })
      .then(
        (data) => {
          setList(sortForOwner(data.storyboards));
          setError(null);
          onWaiting?.(data.storyboards.filter((s) => s.state === "in_review").length);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("storyboards.loadFailed"))
      );
    void fetch(`/api/channels/${encodeURIComponent(channelId)}/storyboard-settings`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setGate(data), () => undefined);
  }, [channelId, t, onWaiting]);

  const saveGate = (requireApproved: boolean) => {
    if (!channelId) return;
    setGateBusy(true);
    void fetch(`/api/channels/${encodeURIComponent(channelId)}/storyboard-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ requireApproved }) })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorText(t, body, t("storyboards.actionFailed"), { showErrorField: false }));
        setGate(body);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("storyboards.actionFailed")))
      .finally(() => setGateBusy(false));
  };

  useEffect(() => {
    if (!channelId) return;
    // Read once even while another tab is shown (the tab bar's badge), then kept fresh only while this tab is open.
    load();
    if (!active) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [active, channelId, load]);

  if (!channelId) return <p className="text-sm text-zinc-400">{t("storyboards.noChannel")}</p>;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-white">{t("storyboards.title")}</h2>
        <p className="max-w-3xl text-sm text-zinc-400">{t("storyboards.help")}</p>
      </div>
      {gate ? (
        <div className={`flex items-start gap-3 rounded-xl border p-3 ${gate.requireApproved ? "border-zinc-800 bg-zinc-900/40" : "border-amber-800 bg-amber-950/20"}`}>
          <ToggleSwitch tone="violet" label={t("storyboards.gate.label")} checked={gate.requireApproved} disabled={gateBusy} onChange={(on) => (on ? saveGate(true) : setConfirmOff(true))} />
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-zinc-100">{t("storyboards.gate.label")}</p>
            <p className="text-xs text-zinc-400">{t(gate.requireApproved ? "storyboards.gate.onHelp" : "storyboards.gate.offHelp")}</p>
            {gate.changedAt ? <p className="text-[11px] text-zinc-500">{t("storyboards.gate.changed", { when: formatDisplayDateTime(gate.changedAt), device: gate.changedBy ?? "—" })}</p> : null}
          </div>
        </div>
      ) : null}
      {confirmOff ? (
        <ConfirmDialog
          title={t("storyboards.gate.offTitle")}
          description={t("storyboards.gate.offText")}
          confirmLabel={t("storyboards.gate.offConfirm")}
          confirmVariant="danger"
          onCancel={() => setConfirmOff(false)}
          onConfirm={() => {
            setConfirmOff(false);
            saveGate(false);
          }}
        />
      ) : null}
      {error ? <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p> : null}
      {list === null && !error ? <p className="text-sm text-zinc-400">{t("common.loading")}</p> : null}
      {list !== null && list.length === 0 ? <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">{t("storyboards.empty")}</p> : null}
      {list !== null && list.length > 0 ? (
        <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
          {list.map((s) => (
            <li key={s.storyboardId}>
              <button type="button" onClick={() => onOpen(s.storyboardId)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-zinc-800/60">
                <span className="min-w-0 flex-1">
                  {/* BL-189 (FO-REQ-0025 C): the version as its own chip right after the title, so a title such as "(v2 от 13.10)" is not read as it. */}
                  <span className="flex min-w-0 items-baseline gap-2">
                    {/* ui-text-ignore: the storyboard's own title (data) */}
                    <span className="truncate font-medium text-white">{s.title}</span>
                    <VersionChip version={s.latestVersion} />
                  </span>
                  <span className="block text-xs text-zinc-400">
                    {t("storyboards.row.summary", { keyframes: s.keyframes, segments: s.segments })}
                    {s.loop ? ` · ${t("storyboards.loop")}` : ""}
                  </span>
                </span>
                {s.openComments > 0 ? <span className="text-xs text-amber-200">{t("storyboards.row.openComments", { count: s.openComments })}</span> : null}
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_TONE[s.state]}`}>{t(STATE_LABEL[s.state])}</span>
                <span className="w-40 text-right text-xs text-zinc-500">{t("storyboards.row.updated", { when: formatDisplayDateTime(s.updatedAt) })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * BL-184 stage 3 (FO-REQ-0024 A/B5): on «Видео», the channel's approved storyboards -- each opens straight on its «Видео» view (the
 * takes of its segments, the joints, the assembled loop). Nothing is shown when there is none.
 */
export function StoryboardVideoLinks({ channelId, active, onOpen }: { channelId: string | null; active: boolean; onOpen: (storyboardId: string) => void }) {
  const t = useT();
  const [list, setList] = useState<StoryboardSummary[]>([]);

  useEffect(() => {
    if (!active || !channelId) return;
    let cancelled = false;
    const load = () =>
      void fetch(`/api/channels/${encodeURIComponent(channelId)}/storyboards`)
        .then((response) => (response.ok ? (response.json() as Promise<{ storyboards: StoryboardSummary[] }>) : null))
        .then(
          (data) => {
            if (!cancelled && data) setList(sortForOwner(data.storyboards).filter((s) => s.state === "approved"));
          },
          () => undefined
        );
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, channelId]);

  if (list.length === 0) return null;
  return (
    <section className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="text-base font-semibold text-zinc-100">{t("storyboards.videoLinks.title")}</h3>
      <p className="text-xs text-zinc-400">{t("storyboards.videoLinks.help")}</p>
      <ul className="space-y-2">
        {list.map((s) => (
          <li key={s.storyboardId}>
            <button type="button" onClick={() => onOpen(s.storyboardId)} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-left hover:border-zinc-700">
              {/* ui-text-ignore: the storyboard's own title (data) */}
              <span className="min-w-0 truncate text-sm font-medium text-zinc-100">{s.title}</span>
              <VersionChip version={s.latestVersion} />
              <span className="min-w-0 flex-1 text-xs text-zinc-400">{t("storyboards.row.summary", { keyframes: s.keyframes, segments: s.segments })}</span>
              <span className="text-xs text-indigo-300">{t("storyboards.videoLinks.open")}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** BL-189 (FO-REQ-0025 C): the latest version's number, shown apart from the Operator's title text. */
function VersionChip({ version }: { version: number }) {
  const t = useT();
  return <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-200">{t("storyboards.row.version", { version })}</span>;
}
