"use client";

import { useCallback, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { useUiText } from "./ui-text-provider";
import type { VideoProjectView } from "./video-projects-panel";

// BL-194 stage 4 (docs/roadmap/plans/VIDEO_COST_PLAN.md §2 stage 4, owner msg 2871): runs made before videos had numbers. This computer
// proposes a video for a storyboard whose render is the video file of a `MMDD Vn` folder (same name and size, then the same hash);
// the owner confirms each one, or picks the video by hand. Nothing is linked without a click here. Runs of a storyboard or plan
// that already has a video are linked on a click too. Every click opens a confirmation first.

type Proposals = {
  workspace: "ok" | "unavailable";
  matches: Array<{ storyboardId: string; title: string; video: string; folder: string; file: string; bytes: number; runs: number }>;
  withoutVideo: Array<{ storyboardId: string; title: string; runs: number }>;
  linkable: Array<{ kind: "storyboard" | "plan"; id: string; title: string; video: string; runs: number }>;
};
type Pending = { kind: "confirm"; storyboardId: string; title: string; video: string; runs: number } | { kind: "link"; target: "storyboard" | "plan"; id: string; title: string; video: string; runs: number };

export function VideoCostsBackfill({ channelId, videos, onChanged }: { channelId: string; videos: VideoProjectView[]; onChanged: () => void }) {
  const { t } = useUiText();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Proposals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/channels/${encodeURIComponent(channelId)}/video-costs/backfill`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base);
      const body = await res.json();
      if (!res.ok) throw new Error(errorText(t, body, t("videoCostsBackfill.loadFailed")));
      setData(body as Proposals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("videoCostsBackfill.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, t]);

  async function run(p: Pending) {
    setBusy(true);
    try {
      const res =
        p.kind === "confirm"
          ? await fetch(`${base}/storyboards/${encodeURIComponent(p.storyboardId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ video: p.video }) })
          : await fetch(`${base}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: p.target, id: p.id }) });
      const body = await res.json();
      if (!res.ok) throw new Error(errorText(t, body, t("videoCostsBackfill.actionFailed")));
      setNotice(t("videoCostsBackfill.linked", { title: p.title, video: (body as { video: string }).video, runs: (body as { linkedRuns: number }).linkedRuns }));
      setError(null);
      onChanged();
    } catch (e) {
      setNotice(null);
      setError(e instanceof Error ? e.message : t("videoCostsBackfill.actionFailed"));
    } finally {
      setBusy(false);
      await load();
    }
  }

  // Old videos are mostly published: any video of the channel that is not cancelled and not in dispute can be chosen.
  const choices = videos.filter((v) => v.state !== "cancelled" && !v.conflict);
  const nothing = data && data.matches.length === 0 && data.withoutVideo.length === 0 && data.linkable.length === 0;

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-zinc-200">{t("videoCostsBackfill.title")}</p>
          <p className="text-xs text-zinc-500">{t("videoCostsBackfill.intro")}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            void load();
          }}
          disabled={loading}
          className="shrink-0 rounded-md bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
        >
          {t(open ? "videoCostsBackfill.recheck" : "videoCostsBackfill.check")}
        </button>
      </div>
      {open && (
        <div className="space-y-2">
          {error && <p className="text-xs text-red-400">{error}</p>}
          {notice && <p className="rounded-md border border-emerald-800/60 bg-emerald-950/20 px-2 py-1.5 text-xs text-emerald-200">{notice}</p>}
          {loading && !data && <LoadingIndicator className="text-xs text-zinc-400" />}
          {data?.workspace === "unavailable" && <p className="text-xs text-amber-300/80">{t("videoCostsBackfill.workspaceUnavailable")}</p>}
          {nothing && <p className="text-xs text-zinc-400">{t("videoCostsBackfill.nothing")}</p>}
          {data && data.matches.length > 0 && (
            <ul className="space-y-1.5">
              {data.matches.map((m) => (
                <li key={`${m.storyboardId}:${m.video}`} className="flex flex-wrap items-center gap-2 rounded-md border border-indigo-900/60 bg-indigo-950/20 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 text-zinc-200">{t("videoCostsBackfill.match", { title: m.title, video: m.video, file: m.file, folder: m.folder.slice(m.folder.lastIndexOf("/") + 1), runs: m.runs })}</span>
                  <button type="button" disabled={busy} onClick={() => setPending({ kind: "confirm", storyboardId: m.storyboardId, title: m.title, video: m.video, runs: m.runs })} className="shrink-0 rounded-md bg-indigo-600 px-2 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                    {t("videoCostsBackfill.linkTo", { video: m.video })}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data && data.withoutVideo.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-zinc-400">{t("videoCostsBackfill.withoutVideo")}</p>
              <ul className="space-y-1.5">
                {data.withoutVideo.map((s) => {
                  const choice = picked[s.storyboardId] ?? "";
                  return (
                    <li key={s.storyboardId} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 text-zinc-200">{t("videoCostsBackfill.storyboardRuns", { title: s.title, runs: s.runs })}</span>
                      <select
                        value={choice}
                        onChange={(e) => setPicked((p) => ({ ...p, [s.storyboardId]: e.target.value }))}
                        aria-label={t("videoCostsBackfill.pickLabel", { title: s.title })}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
                      >
                        <option value="">{t("videoCostsBackfill.pickPlaceholder")}</option>
                        {choices.map((v) => (
                          <option key={v.video} value={v.video}>
                            {v.workingTitle ? `${v.video} · ${v.workingTitle}` : v.video}
                          </option>
                        ))}
                      </select>
                      <button type="button" disabled={busy || !choice} onClick={() => setPending({ kind: "confirm", storyboardId: s.storyboardId, title: s.title, video: choice, runs: s.runs })} className="shrink-0 rounded-md bg-zinc-700 px-2 py-1 text-zinc-100 hover:bg-zinc-600 disabled:opacity-50">
                        {t("videoCostsBackfill.link")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {data && data.linkable.length > 0 && (
            <ul className="space-y-1.5">
              {data.linkable.map((l) => (
                <li key={`${l.kind}:${l.id}`} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 text-zinc-200">{t(l.kind === "plan" ? "videoCostsBackfill.planLinkable" : "videoCostsBackfill.storyboardLinkable", { title: l.title, video: l.video, runs: l.runs })}</span>
                  <button type="button" disabled={busy} onClick={() => setPending({ kind: "link", target: l.kind, id: l.id, title: l.title, video: l.video, runs: l.runs })} className="shrink-0 rounded-md bg-zinc-700 px-2 py-1 text-zinc-100 hover:bg-zinc-600 disabled:opacity-50">
                    {t("videoCostsBackfill.linkRuns", { video: l.video })}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pending && (
        <ConfirmDialog
          title={t(pending.kind === "confirm" ? "videoCostsBackfill.confirmTitle" : "videoCostsBackfill.linkRunsTitle", { title: pending.title, video: pending.video })}
          description={t(pending.kind === "confirm" ? "videoCostsBackfill.confirmDescription" : "videoCostsBackfill.linkRunsDescription", { title: pending.title, video: pending.video, runs: pending.runs })}
          confirmLabel={t("videoCostsBackfill.linkTo", { video: pending.video })}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const p = pending;
            setPending(null);
            void run(p);
          }}
        />
      )}
    </div>
  );
}
