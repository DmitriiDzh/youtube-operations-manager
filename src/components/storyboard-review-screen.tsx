"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoryboardCommentTarget, StoryboardVersion } from "@/lib/sync-gateway";
import type { KeyframeFileStatus, StoryboardDetail, VersionDiff } from "@/lib/storyboards";
import { changedPropCells } from "@/lib/storyboards/model";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { errorText } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { MediaImageViewer, type ViewerPin } from "./media-image-viewer";
import {
  changedMarks,
  commentsFor,
  decisionsOffered,
  diffIsEmpty,
  filmstripOf,
  keyframeSrc,
  openCounts,
  pinsOn,
  STATE_LABEL,
  STATE_TONE,
  targetKey,
  type DetailComment,
} from "./storyboard-model";
import { StoryboardVideoView } from "./storyboard-video-view";
import { useT, useUiText } from "./ui-text-provider";
import { FIT, type ViewState } from "./visual-review-model";

// BL-184 stage 1 (FO-REQ-0024 §4 B2/B3, §5 steps 2-3): one storyboard's review -- the filmstrip (keyframes and the segment of video
// between each two), a keyframe large with zoom and pins and against its neighbour, the prop table with continuity changes lit,
// comments on anything with threads, the version switcher with what changed, and «Запросить изменения» / «Одобрить эту версию».

type Loaded = { storyboard: StoryboardDetail; version: number; files: Record<string, KeyframeFileStatus>; diff: VersionDiff | null };
type Selection = { kind: "storyboard" } | { kind: "keyframe"; keyframeId: string } | { kind: "segment"; segmentId: string } | { kind: "prop"; propId: string; keyframeId: string };
type CompareMode = "side" | "wipe" | "difference";

const POLL_MS = 20_000;

const selectionTarget = (s: Selection, region?: { x: number; y: number; r: number } | null): StoryboardCommentTarget =>
  s.kind === "keyframe" ? { kind: "keyframe", keyframeId: s.keyframeId, region: region ?? null } : s.kind === "segment" ? { kind: "segment", segmentId: s.segmentId } : s.kind === "prop" ? { kind: "prop", propId: s.propId, keyframeId: s.keyframeId } : { kind: "storyboard" };

async function send<T>(t: ReturnType<typeof useT>, url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, json, t("storyboards.actionFailed"), { showErrorField: false }));
  return json as T;
}

export function StoryboardReviewScreen({ channelId, storyboardId, onClose, initialView = "frames" }: { channelId: string; storyboardId: string; onClose: () => void; initialView?: "frames" | "video" }) {
  const t = useT();
  const { formatNumber } = useUiText();
  const base = `/api/channels/${encodeURIComponent(channelId)}/storyboards/${encodeURIComponent(storyboardId)}`;
  const [data, setData] = useState<Loaded | null>(null);
  const [asked, setAsked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: "storyboard" });
  const [showAll, setShowAll] = useState(false);
  const [compare, setCompare] = useState<{ keyframeId: string; mode: CompareMode } | null>(null);
  const [view, setView] = useState<ViewState>(FIT);
  const [split, setSplit] = useState(0.5);
  const [draft, setDraft] = useState("");
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number; r: number } | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"approve" | "changes" | null>(null);
  const [note, setNote] = useState("");
  // BL-184 stage 3 (B5): «Кадры» -- the storyboard's review; «Видео» -- the takes of its segments, the joints, the assembled loop.
  const [screenView, setScreenView] = useState<"frames" | "video">(initialView);
  const composer = useRef<HTMLTextAreaElement | null>(null);

  /** `keepError`: after a refusal, the screen catches up without wiping the refusal's message. */
  const load = useCallback(
    (version: number | null, keepError = false) =>
      fetch(version === null ? base : `${base}?version=${version}`)
        .then(async (response) => {
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(errorText(t, body, t("storyboards.loadFailed"), { showErrorField: false }));
          return body as Loaded;
        })
        .then(
          (loaded) => {
            setData(loaded);
            if (!keepError) setError(null);
          },
          (err: unknown) => setError(err instanceof Error ? err.message : t("storyboards.loadFailed"))
        ),
    [base, t]
  );

  useEffect(() => {
    void load(asked);
    const id = setInterval(() => void load(asked), POLL_MS);
    return () => clearInterval(id);
  }, [asked, load]);

  const sb = data?.storyboard ?? null;
  const version: StoryboardVersion | null = useMemo(() => (sb && data ? (sb.versions.find((v) => v.number === data.version) ?? null) : null), [sb, data]);
  const isLatest = !!sb && !!data && data.version === sb.latestVersion;
  const marks = useMemo(() => changedMarks(data?.diff ?? null), [data?.diff]);
  const counts = useMemo(() => (sb && data ? openCounts(sb.comments, data.version) : new Map<string, number>()), [sb, data]);
  const continuity = useMemo(() => (version ? changedPropCells(version) : new Set<string>()), [version]);

  // A selection that the version shown does not have (another version picked) falls back to the whole storyboard.
  const shownSelection: Selection = useMemo(() => {
    if (!version) return { kind: "storyboard" };
    const has = (id: string) => version.keyframes.some((k) => k.id === id);
    if (selection.kind === "keyframe" && !has(selection.keyframeId)) return { kind: "storyboard" };
    if (selection.kind === "segment" && !version.segments.some((s) => s.id === selection.segmentId)) return { kind: "storyboard" };
    if (selection.kind === "prop" && (!has(selection.keyframeId) || !version.props.some((p) => p.id === selection.propId))) return { kind: "storyboard" };
    return selection;
  }, [selection, version]);

  const select = (next: Selection) => {
    setSelection(next);
    setPendingPin(null);
    setCompare(null);
    setView(FIT);
  };

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      await load(asked);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storyboards.actionFailed"));
      // A refusal often means the storyboard moved on (a newer version, a comment gone): show what it is now.
      void load(asked, true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!sb || !data || !version) {
    return (
      <div className="max-w-6xl space-y-4">
        <button type="button" onClick={onClose} className="text-sm text-zinc-400 hover:text-white">
          ← {t("storyboards.back")}
        </button>
        {error ? <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p> : <p className="text-sm text-zinc-400">{t("common.loading")}</p>}
      </div>
    );
  }

  const keyframeById = new Map(version.keyframes.map((k) => [k.id, k]));
  const segmentById = new Map(version.segments.map((s) => [s.id, s]));
  const propById = new Map(version.props.map((p) => [p.id, p]));
  const offered = decisionsOffered(sb, data.version);
  const src = (keyframeId: string) => keyframeSrc(channelId, storyboardId, data.version, keyframeId);

  const targetLabel = (target: StoryboardCommentTarget): string => {
    switch (target.kind) {
      case "storyboard":
        return t("storyboards.target.storyboard");
      case "keyframe":
        return t("storyboards.target.keyframe", { id: target.keyframeId });
      case "segment": {
        const s = segmentById.get(target.segmentId);
        return s ? t("storyboards.target.segment", { id: s.id, from: s.fromKeyframeId, to: s.toKeyframeId }) : t("storyboards.target.segmentShort", { id: target.segmentId });
      }
      case "prop":
        return t("storyboards.target.prop", { prop: propById.get(target.propId)?.name ?? target.propId, id: target.keyframeId });
    }
  };

  const selectedKey = targetKey(selectionTarget(shownSelection));
  const listed = commentsFor(sb.comments, showAll || shownSelection.kind === "storyboard" ? null : selectedKey);
  const pinNumber = new Map<string, number>();
  if (shownSelection.kind === "keyframe") for (const p of pinsOn(sb.comments, shownSelection.keyframeId, data.version)) pinNumber.set(p.commentId, p.number);

  /** Shift + drag on the keyframe: a pin for the comment being written (one at a time). */
  const addPin = (region: { x: number; y: number; r: number }) => {
    setPendingPin(region);
    composer.current?.focus();
  };

  async function addComment() {
    const text = draft.trim();
    if (!text) return;
    const ok = await act(() => send(t, `${base}/comments`, "POST", { versionNumber: data!.version, target: selectionTarget(shownSelection, pendingPin), text }));
    if (ok) {
      setDraft("");
      setPendingPin(null);
    }
  }

  // ---- pieces ----------------------------------------------------------------------------------------------------------------

  const fileWarning = (status: KeyframeFileStatus | undefined) =>
    status === "differs" ? (
      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200">{t("storyboards.file.differs")}</span>
    ) : status === "missing" ? (
      <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[11px] text-rose-200">{t("storyboards.file.missing")}</span>
    ) : null;
  const countBadge = (key: string) => {
    const n = counts.get(key) ?? 0;
    return n > 0 ? <span className="rounded-full bg-amber-400/90 px-1.5 text-[11px] font-semibold text-zinc-950" title={t("storyboards.openCommentsHere", { count: n })}>{n}</span> : null;
  };
  const changedDot = (on: boolean) => (on ? <span className="rounded-full bg-sky-500/20 px-1.5 text-[11px] text-sky-200">{t("storyboards.changed")}</span> : null);

  const filmstrip = (
    <ol className="flex items-stretch gap-2 overflow-x-auto pb-2" aria-label={t("storyboards.filmstrip")}>
      {filmstripOf(version).map((item, i) => {
        if (item.kind === "segment") {
          const s = item.segment;
          const selected = shownSelection.kind === "segment" && shownSelection.segmentId === s.id;
          return (
            <li key={`s-${s.id}`} className="shrink-0">
              <button
                type="button"
                onClick={() => select({ kind: "segment", segmentId: s.id })}
                aria-pressed={selected}
                className={`flex h-full w-56 flex-col gap-1 rounded-lg border p-2 text-left ${selected ? "border-indigo-400 bg-indigo-950/40" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"}`}
              >
                <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <span className="font-mono font-semibold text-zinc-100">{s.id}</span>
                  <span>→ {t("storyboards.seconds", { value: formatNumber(s.durationSeconds) })}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {changedDot(marks.segments.has(s.id))}
                    {countBadge(`segment:${s.id}`)}
                  </span>
                </span>
                {/* ui-text-ignore: the Operator's action text (data) */}
                <span className="line-clamp-4 text-xs text-zinc-200">{s.action}</span>
                <span className="mt-auto truncate text-[11px] text-zinc-500">
                  {[s.model, s.estimateUsd !== null ? `$${formatNumber(s.estimateUsd, { maximumFractionDigits: 2 })}` : null].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          );
        }
        const k = item.keyframe;
        const selected = !item.closing && shownSelection.kind === "keyframe" && shownSelection.keyframeId === k.id;
        return (
          <li key={`k-${k.id}-${i}`} className="shrink-0">
            <button
              type="button"
              onClick={() => select({ kind: "keyframe", keyframeId: k.id })}
              aria-pressed={selected}
              title={item.closing ? t("storyboards.loopBack", { id: k.id }) : (k.caption ?? undefined)}
              className={`flex w-44 flex-col gap-1 rounded-lg border p-1.5 text-left ${item.closing ? "border-dashed border-zinc-700 opacity-60 hover:opacity-100" : selected ? "border-indigo-400 bg-indigo-950/40" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local file served by our route, shown as it is */}
              <img src={src(k.id)} alt={k.id} loading="lazy" className="h-24 w-full rounded object-cover" />
              <span className="flex items-center gap-1.5 text-xs">
                <span className="font-mono font-semibold text-zinc-100">{item.closing ? `↺ ${k.id}` : k.id}</span>
                {!item.closing ? (
                  <span className="ml-auto flex items-center gap-1">
                    {changedDot(marks.keyframes.has(k.id))}
                    {countBadge(`keyframe:${k.id}`)}
                  </span>
                ) : null}
              </span>
              {/* ui-text-ignore: the keyframe's caption (data) */}
              {k.caption && !item.closing ? <span className="line-clamp-2 text-[11px] text-zinc-400">{k.caption}</span> : null}
              {!item.closing ? fileWarning(data.files[k.id]) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );

  const neighbours = (keyframeId: string) => {
    const i = version.keyframes.findIndex((k) => k.id === keyframeId);
    const n = version.keyframes.length;
    const prev = i > 0 ? version.keyframes[i - 1] : version.loop ? version.keyframes[n - 1] : null;
    const next = i < n - 1 ? version.keyframes[i + 1] : version.loop ? version.keyframes[0] : null;
    return [prev, next].filter((k, j, all): k is NonNullable<typeof k> => !!k && k.id !== keyframeId && all.findIndex((x) => x?.id === k.id) === j);
  };

  const viewerPins = (keyframeId: string): ViewerPin[] => [
    ...pinsOn(sb.comments, keyframeId, data.version).map((p) => ({ region: p.region, label: String(p.number), tone: (p.state === "open" ? "mark" : "previous") as ViewerPin["tone"] })),
    ...(pendingPin && shownSelection.kind === "keyframe" && shownSelection.keyframeId === keyframeId ? [{ region: pendingPin, label: "+", tone: "draft" as const }] : []),
  ];

  const inspector = (() => {
    if (shownSelection.kind === "keyframe") {
      const k = keyframeById.get(shownSelection.keyframeId)!;
      const other = compare ? keyframeById.get(compare.keyframeId) : undefined;
      const canPin = isLatest;
      const overlay = other && compare && compare.mode !== "side" ? { src: src(other.id), mode: compare.mode, split, onSplit: setSplit, labels: { first: k.id, second: other.id } } : undefined;
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-sm font-semibold text-white">{k.id}</span>
            {/* ui-text-ignore: the keyframe's file path (data) */}
            <span className="truncate text-zinc-500">{k.file}</span>
            {fileWarning(data.files[k.id])}
            <span className="ml-auto flex flex-wrap items-center gap-1">
              <span className="text-zinc-400">{t("storyboards.compareWith")}</span>
              {neighbours(k.id).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  aria-pressed={compare?.keyframeId === n.id}
                  onClick={() => setCompare((c) => (c?.keyframeId === n.id ? null : { keyframeId: n.id, mode: c?.mode ?? "side" }))}
                  className={`rounded-md px-2 py-0.5 font-mono ${compare?.keyframeId === n.id ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}
                >
                  {n.id}
                </button>
              ))}
              {k.parentKeyframeId && keyframeById.has(k.parentKeyframeId) ? (
                <button
                  type="button"
                  aria-pressed={compare?.keyframeId === k.parentKeyframeId}
                  onClick={() => setCompare((c) => (c?.keyframeId === k.parentKeyframeId ? null : { keyframeId: k.parentKeyframeId!, mode: c?.mode ?? "side" }))}
                  className={`rounded-md px-2 py-0.5 ${compare?.keyframeId === k.parentKeyframeId ? "bg-zinc-700 text-white" : "text-sky-200 hover:bg-zinc-800"}`}
                  title={t("storyboards.compare.parentHelp")}
                >
                  {t("storyboards.compare.parent", { id: k.parentKeyframeId })}
                </button>
              ) : null}
              {compare
                ? (["side", "wipe", "difference"] as const).map((mode) => (
                    <button key={mode} type="button" aria-pressed={compare.mode === mode} onClick={() => setCompare({ ...compare, mode })} className={`rounded-md px-2 py-0.5 ${compare.mode === mode ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}>
                      {t(mode === "side" ? "storyboards.compare.side" : mode === "wipe" ? "storyboards.compare.wipe" : "storyboards.compare.difference")}
                    </button>
                  ))
                : null}
            </span>
          </div>
          {data.files[k.id] === "differs" ? <p className="text-xs text-amber-200">{t("storyboards.file.differsHelp")}</p> : null}
          {data.files[k.id] === "missing" ? (
            <p className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-200">{t("storyboards.file.missingHelp")}</p>
          ) : other && compare?.mode === "side" ? (
            <div className="grid grid-cols-2 gap-2">
              <MediaImageViewer key={`a-${k.id}`} src={src(k.id)} pins={viewerPins(k.id)} onAddPin={canPin ? addPin : undefined} className="h-[46vh]" view={view} onViewChange={setView} />
              <MediaImageViewer key={`b-${other.id}`} src={src(other.id)} pins={[]} className="h-[46vh]" view={view} onViewChange={setView} />
            </div>
          ) : (
            <MediaImageViewer key={`v-${k.id}`} src={src(k.id)} pins={viewerPins(k.id)} onAddPin={canPin ? addPin : undefined} className="h-[52vh]" overlay={overlay} {...(overlay ? { view, onViewChange: setView } : {})} />
          )}
          {/* ui-text-ignore: the keyframe's caption (data) */}
          {k.caption ? <p className="text-sm text-zinc-300">{k.caption}</p> : null}
          {canPin ? <p className="text-xs text-zinc-500">{t("storyboards.pinHelp")}</p> : null}
        </div>
      );
    }
    if (shownSelection.kind === "segment") {
      const s = segmentById.get(shownSelection.segmentId)!;
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-white">{s.id}</span>
            <span className="text-sm text-zinc-400">{t("storyboards.segmentBetween", { from: s.fromKeyframeId, to: s.toKeyframeId })}</span>
            {changedDot(marks.segments.has(s.id))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[s.fromKeyframeId, s.toKeyframeId].map((id) => (
              <button key={id} type="button" onClick={() => select({ kind: "keyframe", keyframeId: id })} className="space-y-1 text-left">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local file served by our route, shown as it is */}
                <img src={src(id)} alt={id} className="aspect-video w-full rounded object-cover" />
                <span className="font-mono text-xs text-zinc-300">{id}</span>
              </button>
            ))}
          </div>
          {/* ui-text-ignore: the Operator's action text (data) */}
          <p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-100">{s.action}</p>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-400">{t("storyboards.field.duration")}</dt>
            <dd className="text-zinc-100">{t("storyboards.seconds", { value: formatNumber(s.durationSeconds) })}</dd>
            <dt className="text-zinc-400">{t("storyboards.field.model")}</dt>
            {/* ui-text-ignore: the model the Operator named (data) */}
            <dd className="text-zinc-100">{s.model ?? "—"}</dd>
            <dt className="text-zinc-400">{t("storyboards.field.estimate")}</dt>
            {/* ui-text-ignore: a dollar amount */}
            <dd className="text-zinc-100">{s.estimateUsd !== null ? `$${formatNumber(s.estimateUsd, { maximumFractionDigits: 2 })}` : "—"}</dd>
            {Object.entries(s.settings).map(([name, value]) => (
              <div key={name} className="contents">
                {/* ui-text-ignore: a setting's name and value from the Operator (data) */}
                <dt className="font-mono text-xs text-zinc-500">{name}</dt>
                <dd className="font-mono text-xs text-zinc-200">{String(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    }
    return (
      <div className="space-y-2 text-sm">
        <p className="text-zinc-400">{t("storyboards.pickSomething")}</p>
        {version.notes ? (
          <div className="space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t("storyboards.notes")}</h3>
            {/* ui-text-ignore: the Operator's notes (data) */}
            <p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-zinc-100">{version.notes}</p>
          </div>
        ) : null}
        <p className="text-xs text-zinc-500">{t("storyboards.createdAt", { when: formatDisplayDateTime(sb.createdAt) })}</p>
      </div>
    );
  })();

  const commentCard = (c: DetailComment) => (
    <li key={c.id} className={`space-y-2 rounded-lg border p-2.5 ${c.state === "open" ? "border-zinc-700 bg-zinc-900" : "border-zinc-800 bg-zinc-950 opacity-80"}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {pinNumber.has(c.id) ? <span className="rounded-full border border-amber-400 px-1.5 text-amber-200">{pinNumber.get(c.id)}</span> : null}
        {showAll || shownSelection.kind === "storyboard" ? (
          <button type="button" onClick={() => c.versionNumber === data.version && select(c.target.kind === "keyframe" ? { kind: "keyframe", keyframeId: c.target.keyframeId } : c.target.kind === "segment" ? { kind: "segment", segmentId: c.target.segmentId } : c.target.kind === "prop" ? { kind: "prop", propId: c.target.propId, keyframeId: c.target.keyframeId } : { kind: "storyboard" })} className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-200 hover:bg-zinc-700">
            {targetLabel(c.target)}
          </button>
        ) : null}
        {c.versionNumber !== data.version ? <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-400">{t("storyboards.versionChip", { number: c.versionNumber })}</span> : null}
        <span className="text-zinc-300">{t(c.author === "owner" ? "storyboards.author.owner" : "storyboards.author.operator")}</span>
        {/* ui-text-ignore: a computer's name (data) */}
        {c.device ? <span className="text-zinc-500">{c.device}</span> : null}
        <span className="text-zinc-500">{formatDisplayDateTime(c.createdAt)}</span>
        {c.state === "resolved" ? <span className="ml-auto rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-200">{t("storyboards.comment.resolved")}</span> : null}
      </div>
      {/* ui-text-ignore: the comment's text (data) */}
      <p className="whitespace-pre-wrap text-sm text-zinc-100">{c.text}</p>
      {c.replies.length > 0 ? (
        <ul className="space-y-1.5 border-l border-zinc-700 pl-3">
          {c.replies.map((r) => (
            <li key={r.id} className="text-sm">
              <span className="text-[11px] text-zinc-400">
                {t(r.author === "owner" ? "storyboards.author.owner" : "storyboards.author.operator")} · {formatDisplayDateTime(r.createdAt)}
              </span>
              {/* ui-text-ignore: a reply's text (data) */}
              <p className="whitespace-pre-wrap text-zinc-200">{r.text}</p>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={replies[c.id] ?? ""}
          onChange={(e) => setReplies((all) => ({ ...all, [c.id]: e.target.value }))}
          placeholder={t("storyboards.reply.placeholder")}
          aria-label={t("storyboards.reply.placeholder")}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
        />
        <button
          type="button"
          disabled={busy || !(replies[c.id] ?? "").trim()}
          onClick={() =>
            void act(() => send(t, `${base}/comments/${encodeURIComponent(c.id)}`, "POST", { text: (replies[c.id] ?? "").trim() })).then((ok) => ok && setReplies((all) => ({ ...all, [c.id]: "" })))
          }
          className="rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-white hover:bg-zinc-600 disabled:opacity-40"
        >
          {t("storyboards.reply.send")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => send(t, `${base}/comments/${encodeURIComponent(c.id)}`, "PATCH", { state: c.state === "open" ? "resolved" : "open" }))}
          className="rounded-md px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {t(c.state === "open" ? "storyboards.comment.resolve" : "storyboards.comment.reopen")}
        </button>
      </div>
    </li>
  );

  const comments = (
    <aside className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-white">{shownSelection.kind === "storyboard" || showAll ? t("storyboards.comments.all") : targetLabel(selectionTarget(shownSelection))}</h3>
        {shownSelection.kind !== "storyboard" ? (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="ml-auto rounded-md px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800">
            {t(showAll ? "storyboards.comments.onlyThis" : "storyboards.comments.showAll")}
          </button>
        ) : null}
      </div>
      {isLatest ? (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5">
          <textarea
            ref={composer}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder={t("storyboards.comment.placeholder", { target: targetLabel(selectionTarget(shownSelection)) })}
            aria-label={t("storyboards.comment.placeholder", { target: targetLabel(selectionTarget(shownSelection)) })}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
          />
          <div className="flex items-center gap-2 text-xs">
            {pendingPin ? (
              <span className="flex items-center gap-1 text-amber-200">
                {t("storyboards.comment.withPin")}
                <button type="button" onClick={() => setPendingPin(null)} className="rounded px-1 text-zinc-400 hover:bg-zinc-800" aria-label={t("storyboards.comment.removePin")}>
                  ×
                </button>
              </span>
            ) : null}
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void addComment()} className="ml-auto rounded-md bg-indigo-600 px-3 py-1 font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
              {t("storyboards.comment.add")}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">{t("storyboards.comment.latestOnly")}</p>
      )}
      {listed.length === 0 ? <p className="text-sm text-zinc-500">{t("storyboards.comments.none")}</p> : <ul className="space-y-2">{listed.map(commentCard)}</ul>}
    </aside>
  );

  const propTable =
    version.props.length > 0 ? (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-white">{t("storyboards.props.title")}</h3>
        <p className="text-xs text-zinc-500">{t("storyboards.props.help")}</p>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="min-w-full text-sm">
            <thead className="bg-zinc-900 text-xs text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{t("storyboards.props.colProp")}</th>
                {version.keyframes.map((k) => (
                  <th key={k.id} className="px-3 py-2 text-left font-mono font-medium">
                    {k.id}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {version.props.map((p) => (
                <tr key={p.id}>
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-medium text-zinc-100">
                    {/* ui-text-ignore: the prop's name (data) */}
                    <span>{p.name}</span> <span className="text-[11px] font-normal text-zinc-500">{t(p.kind === "character" ? "storyboards.props.character" : "storyboards.props.object")}</span>
                  </th>
                  {version.keyframes.map((k) => {
                    const cellKey = `${p.id}|${k.id}`;
                    const selected = shownSelection.kind === "prop" && shownSelection.propId === p.id && shownSelection.keyframeId === k.id;
                    return (
                      <td key={k.id} className={`p-0 ${continuity.has(cellKey) ? "bg-amber-500/10" : ""}`}>
                        <button type="button" onClick={() => select({ kind: "prop", propId: p.id, keyframeId: k.id })} aria-pressed={selected} className={`flex h-full w-full min-w-32 items-start gap-1 px-3 py-2 text-left ${selected ? "outline outline-1 outline-indigo-400" : "hover:bg-zinc-800/60"}`}>
                          {/* ui-text-ignore: the cell's text (data) */}
                          <span className={`flex-1 ${continuity.has(cellKey) ? "text-amber-100" : "text-zinc-200"}`}>{p.cells[k.id] || "—"}</span>
                          {marks.cells.has(cellKey) ? <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" title={t("storyboards.changed")} /> : null}
                          {countBadge(`prop:${p.id}:${k.id}`)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    ) : null;

  const openOnVersion = sb.comments.filter((c) => c.state === "open" && c.versionNumber === data.version).length;
  const diffSummary =
    data.diff && !diffIsEmpty(data.diff)
      ? [
          data.diff.keyframesReplaced.length ? t("storyboards.diff.keyframesReplaced", { ids: data.diff.keyframesReplaced.join(", ") }) : null,
          data.diff.keyframesAdded.length ? t("storyboards.diff.keyframesAdded", { ids: data.diff.keyframesAdded.join(", ") }) : null,
          data.diff.keyframesRemoved.length ? t("storyboards.diff.keyframesRemoved", { ids: data.diff.keyframesRemoved.join(", ") }) : null,
          data.diff.segmentsChanged.length + data.diff.segmentsAdded.length ? t("storyboards.diff.segments", { ids: [...data.diff.segmentsChanged, ...data.diff.segmentsAdded].join(", ") }) : null,
          data.diff.segmentsRemoved.length ? t("storyboards.diff.segmentsRemoved", { ids: data.diff.segmentsRemoved.join(", ") }) : null,
          data.diff.propCellsChanged.length ? t("storyboards.diff.cells", { count: data.diff.propCellsChanged.length }) : null,
          data.diff.notesChanged ? t("storyboards.diff.notes") : null,
        ].filter(Boolean)
      : [];

  return (
    <div className="max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onClose} className="text-sm text-zinc-400 hover:text-white">
          ← {t("storyboards.back")}
        </button>
        {/* ui-text-ignore: the storyboard's own title (data) */}
        <h2 className="text-lg font-semibold text-white">{version.title}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_TONE[sb.state]}`}>{t(STATE_LABEL[sb.state])}</span>
        <span className="flex items-center gap-1" role="group" aria-label={t("storyboards.versions")}>
          {sb.versions.map((v) => (
            <button
              key={v.number}
              type="button"
              aria-pressed={v.number === data.version}
              onClick={() => {
                setAsked(v.number === sb.latestVersion ? null : v.number);
                setPendingPin(null);
              }}
              className={`rounded-md px-2 py-0.5 text-xs ${v.number === data.version ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"}`}
            >
              {t("storyboards.versionChip", { number: v.number })}
            </button>
          ))}
        </span>
        {offered ? (
          <span className="ml-auto flex gap-2">
            <button type="button" disabled={busy} onClick={() => setDialog("changes")} className="rounded-md border border-rose-700 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-950/50 disabled:opacity-40">
              {t("storyboards.decide.requestChanges")}
            </button>
            <button type="button" disabled={busy || sb.state === "approved"} onClick={() => setDialog("approve")} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
              {t("storyboards.decide.approve")}
            </button>
          </span>
        ) : null}
      </div>

      {!isLatest ? (
        <p className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-300">
          {t("storyboards.olderVersion", { shown: data.version, latest: sb.latestVersion })}{" "}
          <button type="button" onClick={() => setAsked(null)} className="text-indigo-300 underline hover:text-indigo-200">
            {t("storyboards.openLatest")}
          </button>
        </p>
      ) : sb.state === "draft" ? (
        <p className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-300">{t("storyboards.draftNote")}</p>
      ) : sb.state === "approved" ? (
        <p className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-3 text-sm text-emerald-200">{t("storyboards.approvedNote", { when: sb.lastDecision ? formatDisplayDateTime(sb.lastDecision.at) : "" })}</p>
      ) : sb.state === "changes_requested" ? (
        <p className="rounded-lg border border-rose-900 bg-rose-950/30 p-3 text-sm text-rose-200">{t("storyboards.changesNote")}</p>
      ) : null}
      {diffSummary.length > 0 ? (
        <p className="text-sm text-sky-200">
          {t("storyboards.diff.title", { previous: data.version - 1 })} {diffSummary.join(" · ")}
        </p>
      ) : null}
      {error ? <p className="rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p> : null}

      <span className="inline-flex gap-1 rounded-lg bg-zinc-900 p-1" role="group" aria-label={t("storyboards.view.label")}>
        {(["frames", "video"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={screenView === v} onClick={() => setScreenView(v)} className={`rounded-md px-3 py-1 text-sm ${screenView === v ? "bg-zinc-700 text-white" : "text-zinc-300 hover:text-white"}`}>
            {t(v === "frames" ? "storyboards.view.frames" : "storyboards.view.video")}
          </button>
        ))}
      </span>

      {screenView === "video" ? (
        <StoryboardVideoView channelId={channelId} storyboard={sb} version={version} onPicked={() => void load(asked)} />
      ) : (
        <>
          {filmstrip}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),22rem]">
            <div className="min-w-0">{inspector}</div>
            {comments}
          </div>
          {propTable}
        </>
      )}

      {dialog === "approve" ? (
        <ConfirmDialog
          title={t("storyboards.decide.approveTitle", { number: data.version })}
          description={t("storyboards.decide.approveText")}
          confirmLabel={t("storyboards.decide.approve")}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void act(() => send(t, `${base}/decisions`, "POST", { kind: "approved", versionNumber: data.version }));
          }}
        >
          {openOnVersion > 0 ? <p className="text-sm text-amber-200">{t("storyboards.decide.openWarning", { count: openOnVersion })}</p> : null}
        </ConfirmDialog>
      ) : null}
      {dialog === "changes" ? (
        <ConfirmDialog
          title={t("storyboards.decide.changesTitle", { number: data.version })}
          description={t("storyboards.decide.changesText", { count: openOnVersion })}
          confirmLabel={t("storyboards.decide.requestChanges")}
          confirmVariant="danger"
          confirmDisabled={openOnVersion === 0 && !note.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            const text = note.trim();
            void act(() => send(t, `${base}/decisions`, "POST", { kind: "changes_requested", versionNumber: data.version, note: text || null })).then((ok) => ok && setNote(""));
          }}
        >
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("storyboards.decide.notePlaceholder")}
            aria-label={t("storyboards.decide.notePlaceholder")}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
          />
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
