"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryboardVersion } from "@/lib/sync-gateway";
import type { StoryboardDetail } from "@/lib/storyboards";
import { errorText } from "@/lib/ui-text";
import { MediaVideoPlayer } from "./media-video-player";
import { StoryboardRenders } from "./storyboard-renders";
import { assembledLoop, jointsOf, keyframeSrc, segmentsInOrder, takeKey, takeSrc, takesBySegment, takeState, type TakeView } from "./storyboard-model";
import { useT, useUiText } from "./ui-text-provider";
import { SeamFrames } from "./visual-review-tools";

// BL-184 stage 3 (FO-REQ-0024 §4 B5, §5 step 5): a storyboard's video -- each segment's takes between its two keyframes, one pick per
// segment, the joints checked with the seam tools (last frame of segment n against the first of n + 1, and the loop's closure), and
// the picked takes played in order as one loop. The Operator renders the final file; this is the check before that.

const POLL_MS = 20_000;

export function StoryboardVideoView({ channelId, storyboard, version, onPicked }: { channelId: string; storyboard: StoryboardDetail; version: StoryboardVersion; onPicked: () => void }) {
  const t = useT();
  const { formatNumber } = useUiText();
  const base = `/api/channels/${encodeURIComponent(channelId)}/storyboards/${encodeURIComponent(storyboard.storyboardId)}`;
  const [takes, setTakes] = useState<TakeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [large, setLarge] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch(`${base}/takes`)
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(errorText(t, body, t("storyboards.loadFailed"), { showErrorField: false }));
          return body as { takes: TakeView[] };
        })
        .then(
          (data) => {
            setTakes(data.takes);
            setError(null);
          },
          (err: unknown) => setError(err instanceof Error ? err.message : t("storyboards.loadFailed"))
        ),
    [base, t]
  );

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const picks = storyboard.picks[String(version.number)];
  const bySegment = useMemo(() => takesBySegment(takes ?? [], version.number), [takes, version.number]);
  const otherVersions = useMemo(() => [...new Set((takes ?? []).map((tk) => tk.versionNumber).filter((n) => n !== version.number))].sort((a, b) => a - b), [takes, version.number]);

  async function pick(segmentId: string, take: TakeView | null) {
    setBusy(true);
    try {
      const response = await fetch(`${base}/picks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionNumber: version.number, segmentId, take: take ? { source: take.source, jobId: take.jobId } : null }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("storyboards.actionFailed"), { showErrorField: false }));
      setError(null);
      onPicked();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storyboards.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const hostOf = (take: TakeView) => take.device?.hostName ?? t("storyboards.video.anotherComputer");

  const thumb = (keyframeId: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- a local file served by our route, shown as it is
    <img src={keyframeSrc(channelId, storyboard.storyboardId, version.number, keyframeId)} alt={keyframeId} className="h-20 w-32 shrink-0 rounded object-cover" />
  );

  if (takes === null) return error ? <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p> : <p className="text-sm text-zinc-400">{t("common.loading")}</p>;

  const joints = jointsOf(version, takes, picks);
  const loop = assembledLoop(version, takes, picks);

  return (
    <div className="space-y-5">
      {error ? <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p> : null}
      {bySegment.size === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-400">
          {t("storyboards.video.noTakesAtAll")}
          {otherVersions.length > 0 ? ` ${t("storyboards.video.otherVersions", { versions: otherVersions.map((n) => `v${n}`).join(", ") })}` : ""}
        </p>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-white">{t("storyboards.video.title")}</h3>
        {segmentsInOrder(version).map((segment) => {
          const list = bySegment.get(segment.id) ?? [];
          const picked = picks?.[segment.id];
          return (
            <div key={segment.id} className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono font-semibold text-white">{segment.id}</span>
                <span className="text-zinc-400">{t("storyboards.segmentBetween", { from: segment.fromKeyframeId, to: segment.toKeyframeId })}</span>
                <span className="text-xs text-zinc-500">{t("storyboards.seconds", { value: formatNumber(segment.durationSeconds) })}</span>
                {/* ui-text-ignore: the Operator's action text (data) */}
                <span className="line-clamp-1 min-w-0 flex-1 text-xs text-zinc-400">{segment.action}</span>
              </div>
              <div className="flex items-start gap-2 overflow-x-auto pb-1">
                {thumb(segment.fromKeyframeId)}
                <span className="self-center text-zinc-500">→</span>
                {list.length === 0 ? <p className="self-center text-xs text-zinc-500">{t("storyboards.video.noTakes")}</p> : null}
                {list.map((take) => {
                  const state = takeState(take);
                  const isPicked = picked?.source === take.source && picked.jobId === take.jobId;
                  return (
                    <figure key={takeKey(take)} className={`w-56 shrink-0 space-y-1 rounded-md border p-1.5 ${isPicked ? "border-emerald-500 bg-emerald-950/30" : "border-zinc-800"}`}>
                      {state === "ready" ? (
                        <video src={takeSrc(channelId, storyboard.storyboardId, take)} muted loop playsInline controls preload="metadata" className="h-32 w-full rounded bg-black object-contain" />
                      ) : (
                        <div className={`flex h-32 items-center justify-center rounded bg-zinc-900 px-2 text-center text-xs ${state === "failed" ? "text-rose-300" : state === "elsewhere" ? "text-sky-200" : "text-zinc-400"}`}>
                          {state === "working"
                            ? t("storyboards.video.inProgress")
                            : state === "elsewhere"
                              ? t("storyboards.video.elsewhere", { host: hostOf(take) })
                              : take.status === "done" && !take.hasVideo
                                ? t("storyboards.video.noVideoHere")
                                : t("storyboards.video.failed")}
                        </div>
                      )}
                      <figcaption className="flex flex-wrap items-center gap-1 text-[11px]">
                        {/* ui-text-ignore: the template / model that made the take (data) */}
                        <span className="min-w-0 flex-1 truncate text-zinc-300" title={take.error ?? take.label}>
                          {take.label}
                        </span>
                        {/* BL-189 (FO-REQ-0025 A): a take another computer made says which one. */}
                        {take.device ? <span className="w-full truncate text-sky-300">{t("storyboards.video.madeOn", { host: hostOf(take) })}</span> : null}
                        {state === "ready" ? (
                          <button type="button" onClick={() => setLarge((l) => (l === takeKey(take) ? null : takeKey(take)))} className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800">
                            {t(large === takeKey(take) ? "storyboards.video.closeLarge" : "storyboards.video.enlarge")}
                          </button>
                        ) : null}
                        {state === "ready" ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void pick(segment.id, isPicked ? null : take)}
                            aria-pressed={isPicked}
                            className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${isPicked ? "bg-emerald-600 text-white hover:bg-emerald-500" : "bg-zinc-700 text-white hover:bg-zinc-600"}`}
                          >
                            {t(isPicked ? "storyboards.video.picked" : "storyboards.video.pick")}
                          </button>
                        ) : null}
                      </figcaption>
                    </figure>
                  );
                })}
                <span className="self-center text-zinc-500">→</span>
                {thumb(segment.toKeyframeId)}
              </div>
              {list.some((take) => large === takeKey(take)) ? (
                <MediaVideoPlayer key={large} src={takeSrc(channelId, storyboard.storyboardId, list.find((take) => large === takeKey(take))!)} markers={[]} fps={null} className="h-[46vh]" />
              ) : null}
            </div>
          );
        })}
      </section>

      {joints.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-white">{t("storyboards.video.joints")}</h3>
          {joints.map((joint) =>
            joint.fromTake && joint.toTake ? (
              <SeamFrames
                key={`${joint.from.id}>${joint.to.id}`}
                src={takeSrc(channelId, storyboard.storyboardId, joint.fromTake)}
                nextSrc={takeSrc(channelId, storyboard.storyboardId, joint.toTake)}
                fps={null}
                hint={t(joint.closing ? "storyboards.video.jointClosing" : "storyboards.video.joint", { from: joint.from.id, to: joint.to.id })}
                labels={{ last: t("storyboards.video.lastOf", { id: joint.from.id }), first: t("storyboards.video.firstOf", { id: joint.to.id }) }}
              />
            ) : (
              <p key={`${joint.from.id}>${joint.to.id}`} className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500">
                {t("storyboards.video.jointNeedsPicks", { from: joint.from.id, to: joint.to.id })}
              </p>
            )
          )}
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-white">{t("storyboards.video.assembled")}</h3>
        {/* BL-189 (FO-REQ-0025 B): the Operator's final files first; the in-browser preview of the picks below. */}
        <StoryboardRenders channelId={channelId} storyboard={storyboard} version={version} onDecided={onPicked} />
        <h4 className="pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{t("storyboards.render.preview")}</h4>
        {loop.takes.length > 0 ? (
          <AssembledLoop key={loop.takes.map(takeKey).join("|")} sources={loop.takes.map((take) => ({ key: takeKey(take), segmentId: take.segmentId, src: takeSrc(channelId, storyboard.storyboardId, take) }))} loop={version.loop} />
        ) : (
          <p className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-500">{t("storyboards.video.assembledNeedsPicks", { missing: loop.missing.join(", ") })}</p>
        )}
      </section>
    </div>
  );
}

/** The picked takes one after the other in one player (client-side, no file is made): the next starts when one ends. */
function AssembledLoop({ sources, loop }: { sources: Array<{ key: string; segmentId: string; src: string }>; loop: boolean }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const current = sources[Math.min(index, sources.length - 1)];

  useEffect(() => {
    // A new take loaded: keep playing if the previous one was playing (the loop goes on by itself).
    if (playing) void video.current?.play().catch(() => setPlaying(false));
  }, [index, playing]);

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <p className="text-xs text-zinc-400">{t(loop ? "storyboards.video.assembledHelpLoop" : "storyboards.video.assembledHelp")}</p>
      <video
        ref={video}
        src={current.src}
        muted
        playsInline
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          if (!event.currentTarget.ended) setPlaying(false);
        }}
        onEnded={() => {
          if (index + 1 < sources.length) setIndex(index + 1);
          else if (loop) setIndex(0);
          else setPlaying(false);
          if (sources.length === 1 && loop) void video.current?.play();
        }}
        controls
        className="h-[46vh] w-full rounded bg-black object-contain"
      />
      <div className="flex flex-wrap gap-1" role="group" aria-label={t("storyboards.video.assembled")}>
        {sources.map((source, i) => (
          <button key={source.key} type="button" aria-pressed={i === index} onClick={() => setIndex(i)} className={`rounded-md px-2 py-0.5 font-mono text-xs ${i === index ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}>
            {source.segmentId}
          </button>
        ))}
      </div>
    </div>
  );
}
