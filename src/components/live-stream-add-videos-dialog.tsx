"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@/lib/ui-text";
import type { UiTextKey } from "@/lib/ui-text";
import type { MatchSource, PickerResult, PickerRow, PickerVideo } from "@/lib/live-streams";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useDialogFocus } from "./use-dialog-focus";
import { useT } from "./ui-text-provider";

// BL-187 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §2.4): «Добавить видео…» -- the channel folder's release videos as a
// list to tick, instead of one video ID and path at a time. Each row shows what the app knows about the file (the YouTube
// video it is, where that came from, whether it can stream); nothing is ticked for the owner. A file the app cannot match
// offers the channel's videos of the same length to choose from. «Добавить N» adds them in list order, each checked again
// by the server exactly as a single add.

type AddResult = {
  added: Array<{ videoId: string }>;
  refused: Array<{
    videoId: string;
    originalPath: string;
    code: string;
    reason: string | null;
    message: string;
  }>;
};

const SOURCE_KEYS: Record<MatchSource, UiTextKey> = {
  operator_map: "live.picker.source.operator_map",
  upload_record: "live.picker.source.upload_record",
  registry: "live.picker.source.registry",
};

const REFUSAL_KEYS: Record<string, UiTextKey> = {
  not_channel_video: "live.picker.refusal.not_channel_video",
  file_unavailable: "live.picker.refusal.file_unavailable",
  no_video_stream: "live.picker.refusal.no_video_stream",
  audio_unsupported: "live.picker.refusal.audio_unsupported",
  duration_unknown: "live.picker.refusal.duration_unknown",
  duration_mismatch: "live.picker.refusal.duration_mismatch",
  private: "live.picker.refusal.private",
  unlisted: "live.picker.refusal.unlisted",
  scheduled: "live.picker.refusal.scheduled",
  not_found: "live.picker.refusal.not_found",
  unknown: "live.picker.refusal.unknown",
};

const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Public with no future `publishAt`, as the synced copy says (the server reads YouTube fresh when adding). */
function isPublicNow(video: PickerVideo, now: number): boolean {
  const at = video.publishAt ? Date.parse(video.publishAt) : NaN;
  return video.privacyStatus === "public" && !(Number.isFinite(at) && at > now);
}

export function LiveStreamAddVideosDialog({
  base,
  rotationIds,
  onClose,
  onAdded,
}: {
  base: string;
  rotationIds: ReadonlySet<string>;
  onClose: () => void;
  onAdded: () => Promise<void>;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement | null>(null);
  useDialogFocus(root);
  const [showAll, setShowAll] = useState(false);
  const [publicOnly, setPublicOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<PickerResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** file → the video the owner chose for a row the app could not match. */
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<AddResult | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const now = Date.now();

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${base}/rotation/candidates${showAll ? "?all=1" : ""}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("live.loadFailed"), { showErrorField: false }));
      setResult(body as PickerResult);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("live.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, showAll, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => (result?.status === "ok" ? result.rows : []), [result]);

  /** The video a row would add: its match when it is available, else the one the owner chose (public, not in the rotation). */
  const videoFor = useCallback(
    (row: PickerRow): PickerVideo | null => {
      if (row.state === "available") return row.match;
      if (row.state !== "needs_choice" && row.state !== "conflict") return null;
      const pick = row.suggestions.find((s) => s.videoId === chosen[row.file]);
      return pick && isPublicNow(pick, now) && !rotationIds.has(pick.videoId) ? pick : null;
    },
    [chosen, now, rotationIds],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (publicOnly && row.state === "not_public") return false;
      if (!q) return true;
      return [row.vNumber ?? "", row.fileName, row.match?.title ?? ""].some((text) => text.toLowerCase().includes(q));
    });
  }, [rows, publicOnly, query]);

  // A video may be ticked on one row only (two files cannot both be the same YouTube video).
  const selectedVideoIds = useMemo(
    () =>
      new Set(
        rows
          .filter((r) => selected.has(r.file))
          .map((r) => videoFor(r)?.videoId)
          .filter(Boolean),
      ),
    [rows, selected, videoFor],
  );
  const selectable = (row: PickerRow) => {
    const video = videoFor(row);
    return video !== null && (selected.has(row.file) || !selectedVideoIds.has(video.videoId));
  };
  const picked = rows.filter((row) => selected.has(row.file) && videoFor(row) !== null);
  const totalSeconds = picked.reduce((sum, row) => sum + (row.durationSeconds ?? videoFor(row)?.durationSeconds ?? 0), 0);

  const toggle = (row: PickerRow, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(row.file);
      else next.delete(row.file);
      return next;
    });

  const selectAll = () => {
    const next = new Set(selected);
    const ids = new Set(selectedVideoIds);
    for (const row of visible) {
      const video = videoFor(row);
      if (!video || next.has(row.file) || ids.has(video.videoId)) continue;
      next.add(row.file);
      ids.add(video.videoId);
    }
    setSelected(next);
  };

  async function add() {
    const items = picked.map((row) => ({
      videoId: videoFor(row)!.videoId,
      originalPath: row.file,
    }));
    if (items.length === 0) return;
    setAdding(true);
    setAddError(null);
    setOutcome(null);
    try {
      const response = await fetch(`${base}/rotation/batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("live.actionFailed"), { showErrorField: false }));
      setOutcome(body as AddResult);
      setSelected(new Set());
      setChosen({});
      await onAdded();
      await load();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("live.actionFailed"));
      // A batch that stopped midway (the disk went away, an unexpected error) may already have added some videos: show the
      // rotation and the list as they are now, not as they were before «Добавить».
      await onAdded().catch(() => undefined);
      await load();
    } finally {
      setAdding(false);
    }
  }

  const refusalText = (r: AddResult["refused"][number]) => {
    const key = r.reason ? REFUSAL_KEYS[r.reason] : r.code === "validation_failed" ? "live.picker.refusal.already" : undefined;
    return key ? t(key) : r.message;
  };
  const labelOf = (videoId: string) => rows.find((r) => videoFor(r)?.videoId === videoId || r.match?.videoId === videoId)?.vNumber ?? videoId;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation">
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={t("live.picker.title")}
        tabIndex={-1}
        className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl"
      >
        <div className="space-y-3 border-b border-zinc-800 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-base font-medium text-zinc-100">{t("live.picker.title")}</h2>
              <p className="text-xs text-zinc-400">{t("live.picker.intro")}</p>
            </div>
            <button onClick={onClose} className={buttonClass}>
              {t("common.close")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("live.picker.search")}
              aria-label={t("live.picker.search")}
              className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100"
            />
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <ToggleSwitch checked={publicOnly} onChange={setPublicOnly} label={t("live.picker.publicOnly")} />
              <span>{t("live.picker.publicOnly")}</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-300" title={t("live.picker.showAllHint")}>
              <ToggleSwitch checked={showAll} onChange={setShowAll} label={t("live.picker.showAll")} />
              <span>{t("live.picker.showAll")}</span>
            </label>
            <button onClick={() => void load()} disabled={loading || adding} className={buttonClass}>
              {t("live.picker.reread")}
            </button>
          </div>
          {result?.status === "ok" && result.ffprobeMissing && <p className="text-xs text-amber-300">{t("live.picker.noFfprobe")}</p>}
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto px-4">
          {loading && !result ? (
            <LoadingIndicator className="py-6 text-sm text-zinc-400" label={t("live.picker.loading")} />
          ) : loadError ? (
            <p className="py-6 text-sm text-red-400">{loadError}</p>
          ) : result?.status === "no_workspace" ? (
            <p className="py-6 text-sm text-amber-300">{t("live.picker.noWorkspace")}</p>
          ) : result?.status === "workspace_unavailable" ? (
            <p className="py-6 text-sm text-amber-300">{t("live.picker.unavailable", { reason: result.reason })}</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-sm text-zinc-500">{t("live.picker.empty")}</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-sm text-zinc-500">{t("live.picker.emptyFiltered")}</p>
          ) : (
            <ul className={`divide-y divide-zinc-800 ${loading ? "opacity-60" : ""}`}>
              {visible.map((row) => (
                <PickerRowView
                  key={row.file}
                  row={row}
                  video={videoFor(row)}
                  checked={selected.has(row.file)}
                  canCheck={selectable(row) && !adding}
                  onCheck={(on) => toggle(row, on)}
                  chosenId={chosen[row.file] ?? ""}
                  onChoose={(videoId) => {
                    setChosen((prev) => ({ ...prev, [row.file]: videoId }));
                    toggle(row, videoId !== "" && !selectedVideoIds.has(videoId));
                  }}
                  rotationIds={rotationIds}
                  now={now}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2 border-t border-zinc-800 p-4">
          {adding && <LoadingIndicator className="text-xs text-zinc-400" label={t("live.picker.adding")} />}
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          {outcome && (
            <div className="space-y-1 text-xs">
              <p className={outcome.refused.length > 0 ? "text-amber-300" : "text-emerald-400"}>
                {t("live.picker.result", {
                  added: String(outcome.added.length),
                  refused: String(outcome.refused.length),
                })}
              </p>
              {outcome.refused.map((r) => (
                <p key={r.videoId} className="text-zinc-400">
                  {t("live.picker.refusedItem", {
                    video: labelOf(r.videoId),
                    reason: refusalText(r),
                  })}
                </p>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-zinc-400">
              {t("live.picker.selected", {
                count: String(picked.length),
                duration: clock(totalSeconds),
              })}
            </p>
            <button onClick={selectAll} disabled={adding || loading} className={buttonClass}>
              {t("live.picker.selectAll")}
            </button>
            <button onClick={() => setSelected(new Set())} disabled={adding || selected.size === 0} className={buttonClass}>
              {t("live.picker.clear")}
            </button>
            <button onClick={() => void add()} disabled={adding || picked.length === 0} className={primaryClass}>
              {t("live.picker.add", { count: picked.length })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PickerRowView({
  row,
  video,
  checked,
  canCheck,
  onCheck,
  chosenId,
  onChoose,
  rotationIds,
  now,
}: {
  row: PickerRow;
  video: PickerVideo | null;
  checked: boolean;
  canCheck: boolean;
  onCheck: (on: boolean) => void;
  chosenId: string;
  onChoose: (videoId: string) => void;
  rotationIds: ReadonlySet<string>;
  now: number;
}) {
  const t = useT();
  const shown = row.match ?? video;
  const greyed = row.state === "in_rotation" || row.state === "not_public";
  const status = (() => {
    if (row.state === "in_rotation") return { text: t("live.picker.state.inRotation"), tone: "text-zinc-500" };
    if (row.state === "not_public" && row.match) {
      const at = row.match.publishAt ? Date.parse(row.match.publishAt) : NaN;
      if (Number.isFinite(at) && at > now)
        return {
          text: t("live.picker.state.scheduled", {
            at: new Date(at).toLocaleString(t.language),
          }),
          tone: "text-amber-300",
        };
      return {
        text: row.match.privacyStatus === "unlisted" ? t("live.picker.state.unlisted") : t("live.picker.state.private"),
        tone: "text-amber-300",
      };
    }
    if (row.state === "conflict") return { text: t("live.picker.state.conflict"), tone: "text-amber-300" };
    if (row.state === "needs_choice" && !video) return { text: t("live.picker.state.noMatch"), tone: "text-zinc-400" };
    return null;
  })();
  const id = `pick-${row.file}`;
  return (
    <li className={`flex items-start gap-3 py-2.5 ${greyed ? "opacity-50" : ""}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={!canCheck && !checked}
        onChange={(e) => onCheck(e.target.checked)}
        className="mt-3 h-4 w-4 shrink-0 accent-zinc-100"
      />
      <label htmlFor={id} className="shrink-0">
        {shown?.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the video's YouTube thumbnail from the synced copy
          <img src={shown.thumbnailUrl} alt="" loading="lazy" className="h-[54px] w-24 rounded object-cover" />
        ) : (
          <div className="h-[54px] w-24 rounded bg-zinc-800" />
        )}
      </label>
      <div className="min-w-0 flex-1 space-y-0.5">
        <label htmlFor={id} className="block truncate text-sm text-zinc-100">
          {row.vNumber && <span className="mr-1.5 font-mono text-zinc-400">{row.vNumber}</span>}
          {shown?.title ?? row.fileName}
        </label>
        <p className="truncate text-xs text-zinc-500">
          {row.fileName}
          {row.durationSeconds !== null && ` · ${clock(row.durationSeconds)}`}
          {row.match && ` · ${t(SOURCE_KEYS[row.match.source])}`}
          {!row.match && video && ` · ${t("live.picker.chosenByYou")}`}
        </p>
        {status && <p className={`text-xs ${status.tone}`}>{status.text}</p>}
        {(row.state === "needs_choice" || row.state === "conflict") &&
          (row.suggestions.length > 0 ? (
            <select
              value={chosenId}
              onChange={(e) => onChoose(e.target.value)}
              aria-label={t("live.picker.choose")}
              className="mt-1 max-w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100"
            >
              <option value="">{t("live.picker.choose")}</option>
              {row.suggestions.map((s) => {
                const ok = isPublicNow(s, now) && !rotationIds.has(s.videoId);
                return (
                  <option key={s.videoId} value={s.videoId} disabled={!ok}>
                    {ok
                      ? `${s.title}${s.durationSeconds !== null ? ` (${clock(s.durationSeconds)})` : ""}`
                      : t("live.picker.notPublicOption", { title: s.title })}
                  </option>
                );
              })}
            </select>
          ) : (
            <p className="text-xs text-zinc-500">{t("live.picker.chooseNone")}</p>
          ))}
      </div>
    </li>
  );
}
