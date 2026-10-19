"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { formatDisplayDateUtc, parseDisplayDate } from "@/lib/shared-formatting";
import { SUPPORTED_YOUTUBE_LANGUAGES } from "@/lib/youtube-supported-languages";
import { TAG_MAX_CHARACTERS, TAGS_MAX_CHARACTERS, tagsLength, THUMBNAIL_MAX_BYTES, VIDEO_CATEGORY_IDS, VIDEO_LICENSES, type VideoLicense } from "@/lib/youtube-video-fields";
// The pure fields file (no server code): the same lists and defaults the server validates with.
import {
  DEFAULT_LIVE_VIDEO_SETTINGS,
  LIVE_LATENCIES,
  LIVE_STUDIO_ONLY_FIELDS,
  MAX_STREAM_PLAYLISTS,
  type LiveLatency,
  type LiveVideoSettings,
} from "@/lib/live-streams/fields";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { parseChannelTags } from "./publishing-settings-panel";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

// BL-186 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §2.1/§2.2): the stream's own YouTube settings -- every field the API can
// set (owner msgs 2782/2785: "добавь все параметры в раздел трансляции"), grouped the way Studio groups them: the image; the
// video's details; its marks; playlists; the broadcast itself. What only Studio can set is listed, labelled, at the end. Saving
// stays on this computer. Start sends the broadcast part; the rest is applied after the test broadcast (plan §5, stage 3) -- the
// card says so, so the owner never assumes a value reached YouTube.

type Form = Omit<LiveVideoSettings, "v" | "thumbnail">;
type Playlist = { id: string; title: string };

const cardClass = "space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const sectionClass = "space-y-2 border-t border-zinc-800 pt-3";
const sectionTitleClass = "text-xs font-medium uppercase tracking-wide text-zinc-500";
const inputClass = "rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";

const LATENCY_KEYS: Record<LiveLatency, UiTextKey> = {
  normal: "live.video.latency.normal",
  low: "live.video.latency.low",
  ultraLow: "live.video.latency.ultraLow",
};

const STUDIO_ONLY_KEYS: Record<(typeof LIVE_STUDIO_ONLY_FIELDS)[number], UiTextKey> = {
  ageRestriction: "live.video.studioOnly.ageRestriction",
  adBreaks: "live.video.studioOnly.adBreaks",
  autoChapters: "live.video.studioOnly.autoChapters",
  featuredPlaces: "live.video.studioOnly.featuredPlaces",
  concepts: "live.video.studioOnly.concepts",
  comments: "live.video.studioOnly.comments",
  chat: "live.video.studioOnly.chat",
  promotion: "live.video.studioOnly.promotion",
  remixing: "live.video.studioOnly.remixing",
};

const FLAGS: Array<{ field: "containsSyntheticMedia" | "paidProductPlacement" | "publicStatsViewable"; label: UiTextKey; hint: UiTextKey }> = [
  { field: "containsSyntheticMedia", label: "live.video.field.synthetic", hint: "live.video.hint.synthetic" },
  { field: "paidProductPlacement", label: "live.video.field.paidPromotion", hint: "live.video.hint.paidPromotion" },
  { field: "publicStatsViewable", label: "live.video.field.publicStats", hint: "live.video.hint.publicStats" },
];

function formOf(saved: LiveVideoSettings | null): Form {
  const { v, thumbnail, ...form } = saved ?? DEFAULT_LIVE_VIDEO_SETTINGS;
  void v;
  void thumbnail;
  return form;
}

async function request<T>(url: string, init: RequestInit, fallback: string, t: ReturnType<typeof useT>): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorText(t, body, fallback, { showErrorField: false }));
  return body as T;
}

export function LiveStreamVideoSettingsCard({
  base,
  channelLanguage,
  saved,
  problem,
  onChanged,
}: {
  base: string;
  /** Owner msg 3153: the channel's baseline language, which the broadcast always gets. */
  channelLanguage: string | null;
  saved: LiveVideoSettings | null;
  problem: string | null;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const savedForm = formOf(saved);
  const savedKey = JSON.stringify(savedForm);
  const [form, setForm] = useState<Form>(savedForm);
  const [tagsText, setTagsText] = useState(savedForm.tags.join(", "));
  const [dateText, setDateText] = useState(savedForm.recordingDate ? formatDisplayDateUtc(savedForm.recordingDate) : "");
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);
  // BL-197: the list is remembered on the server for 1 h; "Refresh list" reads it live (each press bumps this).
  const [playlistsReload, setPlaylistsReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A newly saved value (this page's save, or the poll) replaces the form only while the owner has no unsaved edit.
  const dirtyRef = useRef(false);
  const dirty = JSON.stringify(form) !== savedKey;
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    const next = JSON.parse(savedKey) as Form;
    setForm(next);
    setTagsText(next.tags.join(", "));
    setDateText(next.recordingDate ? formatDisplayDateUtc(next.recordingDate) : "");
  }, [savedKey]);

  // The channel's playlists, read once from YouTube (1 unit) -- the same list the publishing defaults use.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/youtube/playlists${playlistsReload > 0 ? "?refresh=1" : ""}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(errorText(t, body, t("live.video.playlistsFailed"), { showErrorField: false }));
        return body as Playlist[];
      })
      .then(
        (list) => !cancelled && setPlaylists(list.map((p) => ({ id: p.id, title: p.title }))),
        (err: unknown) => !cancelled && setPlaylistsError(err instanceof Error ? err.message : t("live.video.playlistsFailed"))
      );
    return () => {
      cancelled = true;
    };
  }, [t, playlistsReload]);

  const tagChars = tagsLength(form.tags);
  const tagProblem =
    form.tags.find((tag) => [...tag].length > TAG_MAX_CHARACTERS || /[<>]/.test(tag)) !== undefined
      ? t("live.video.tags.badTag", { max: String(TAG_MAX_CHARACTERS) })
      : tagChars > TAGS_MAX_CHARACTERS
        ? t("live.video.tags.tooLong", { chars: String(tagChars), max: String(TAGS_MAX_CHARACTERS) })
        : null;
  const dateValid = dateText.trim() === "" || parseDisplayDate(dateText) !== null;
  const tooManyPlaylists = form.playlists.length > MAX_STREAM_PLAYLISTS;
  const valid = !tagProblem && dateValid && !tooManyPlaylists;

  // Playlists the form names that the channel's list no longer has stay visible (never dropped silently).
  const playlistRows = useMemo(() => {
    const known = playlists ?? [];
    const missing = form.playlists.filter((p) => !known.some((k) => k.id === p.id));
    return [...known, ...missing];
  }, [playlists, form.playlists]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("live.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    void run(
      () => request(`${base}/video-settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(form) }, t("settings.saveFailed"), t),
      t("live.video.saved")
    );
  }

  function uploadThumbnail(file: File) {
    if (file.size > THUMBNAIL_MAX_BYTES) {
      setError(t("live.video.thumbnail.tooBig"));
      return;
    }
    void run(async () => {
      await request(`${base}/thumbnail`, { method: "PUT", body: new Uint8Array(await file.arrayBuffer()) }, t("live.video.thumbnail.failed"), t);
    }, t("live.video.thumbnail.saved"));
  }

  const thumbnail = saved?.thumbnail ?? null;
  const languageOptions = SUPPORTED_YOUTUBE_LANGUAGES;

  return (
    <div className={cardClass}>
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("live.video.title")}
          <InfoTooltip>{t("live.video.info")}</InfoTooltip>
        </h3>
        <p className="mt-1 text-xs text-zinc-400">{t("live.video.intro")}</p>
      </div>
      {problem && <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{t("live.video.problem", { problem })}</p>}
      {!saved && !problem && <p className="text-xs text-zinc-500">{t("live.video.notSaved")}</p>}

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.thumbnail")}</h4>
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex aspect-video w-48 items-center justify-center overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
            {thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local, auth-gated image served by this app
              <img src={`${base}/thumbnail?v=${thumbnail.sha256.slice(0, 12)}`} alt={t("live.video.thumbnail.alt")} className="h-full w-full object-cover" />
            ) : (
              <span className="px-2 text-center text-xs text-zinc-500">{t("live.video.thumbnail.none")}</span>
            )}
          </div>
          <div className="space-y-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) uploadThumbnail(file);
              }}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={buttonClass}>
                {thumbnail ? t("live.video.thumbnail.replace") : t("live.video.thumbnail.choose")}
              </button>
              {thumbnail && (
                <button type="button" onClick={() => void run(() => request(`${base}/thumbnail`, { method: "DELETE" }, t("live.video.thumbnail.failed"), t), t("live.video.thumbnail.removed"))} disabled={busy} className={buttonClass}>
                  {t("live.video.thumbnail.remove")}
                </button>
              )}
            </div>
            <p className="text-xs text-zinc-500">{t("live.video.thumbnail.hint")}</p>
            {thumbnail && <p className="text-xs text-zinc-500">{t("live.video.thumbnail.facts", { kind: thumbnail.kind.toUpperCase(), size: String(Math.round(thumbnail.bytes / 1024)) })}</p>}
          </div>
        </div>
      </section>

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.details")}</h4>
        <label className="flex max-w-3xl flex-col gap-1 text-xs text-zinc-400">
          {t("live.video.field.tags")}
          <input
            type="text"
            value={tagsText}
            onChange={(e) => {
              setTagsText(e.target.value);
              setForm({ ...form, tags: parseChannelTags(e.target.value) });
            }}
            disabled={busy}
            placeholder={t("live.video.tags.placeholder")}
            className={inputClass}
          />
          <span className={tagProblem ? "text-red-400" : "text-zinc-500"}>
            {tagProblem ?? t("live.video.tags.count", { count: String(form.tags.length), chars: String(tagChars), max: String(TAGS_MAX_CHARACTERS) })}
          </span>
        </label>
        <div className="flex flex-wrap items-start gap-4">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("live.video.field.category")}
            <select value={form.categoryId ?? ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value || null })} disabled={busy} className={inputClass}>
              <option value="">{t("live.video.notSet")}</option>
              {VIDEO_CATEGORY_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`publishingSettings.category.${id}` as UiTextKey)}
                </option>
              ))}
            </select>
          </label>
          {/* Owner, Telegram msg 3153 (option а): always the channel's baseline language -- shown, not chosen here, so Batches
              (which align every video to the baseline) and the stream never undo each other. */}
          <div className="flex max-w-64 flex-col gap-1 text-xs text-zinc-400">
            {t("live.video.field.defaultLanguage")}
            <p className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-200">
              {channelLanguage ? `${channelLanguage} — ${languageOptions.find((l) => l.code === channelLanguage)?.name ?? channelLanguage}` : t("live.video.notSet")}
            </p>
            <span className="text-[11px] text-zinc-500">{channelLanguage ? t("live.video.languageFromChannel") : t("live.video.languageFromChannelMissing")}</span>
          </div>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("live.video.field.audioLanguage")}
            <select value={form.defaultAudioLanguage ?? ""} onChange={(e) => setForm({ ...form, defaultAudioLanguage: e.target.value || null })} disabled={busy} className={`${inputClass} max-w-56`}>
              <option value="">{t("live.video.notSet")}</option>
              <option value="zxx">{t("live.video.audioNotApplicable")}</option>
              {languageOptions.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.code} — {lang.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("live.video.field.recordingDate")}
            <input
              type="text"
              inputMode="numeric"
              value={dateText}
              placeholder={t("video.format.date")}
              onChange={(e) => {
                setDateText(e.target.value);
                setForm({ ...form, recordingDate: e.target.value.trim() === "" ? null : parseDisplayDate(e.target.value) ?? form.recordingDate });
              }}
              disabled={busy}
              className={`${inputClass} w-32 ${dateValid ? "" : "border-red-500"}`}
            />
            {!dateValid && <span className="text-red-400">{t("live.video.dateInvalid")}</span>}
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            {t("live.video.field.license")}
            <select value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value as VideoLicense })} disabled={busy} className={inputClass}>
              {VIDEO_LICENSES.map((license) => (
                <option key={license} value={license}>
                  {t(`publishingSettings.license.${license}` as UiTextKey)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-zinc-500">{t("live.video.translationsNote")}</p>
      </section>

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.marks")}</h4>
        <div className="space-y-2">
          {FLAGS.map(({ field, label, hint }) => (
            <div key={field} className="flex items-start gap-2">
              <ToggleSwitch tone="violet" label={t(label)} checked={form[field]} onChange={(checked) => setForm({ ...form, [field]: checked })} disabled={busy} />
              <div>
                <p className="text-sm text-zinc-300">{t(label)}</p>
                <p className="text-xs text-zinc-500">{t(hint)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.playlists")}</h4>
        {playlists === null && !playlistsError && <LoadingIndicator className="text-xs text-zinc-400" />}
        {playlistsError && <p className="text-xs text-amber-300">{t("live.video.playlistsUnavailable", { message: playlistsError })}</p>}
        <button
          type="button"
          onClick={() => {
            setPlaylistsError(null);
            setPlaylists(null);
            setPlaylistsReload((n) => n + 1);
          }}
          disabled={busy || (playlists === null && !playlistsError)}
          className="self-start text-xs text-sky-400 hover:underline disabled:opacity-50"
        >
          {t("live.video.playlistsRefresh")}
        </button>
        {playlistRows.length === 0 && playlists !== null && <p className="text-xs text-zinc-500">{t("live.video.playlistsNone")}</p>}
        {playlistRows.length > 0 && (
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {playlistRows.map((p) => {
              const checked = form.playlists.some((x) => x.id === p.id);
              const known = (playlists ?? []).some((k) => k.id === p.id);
              return (
                <li key={p.id}>
                  <label className="flex items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || (!checked && form.playlists.length >= MAX_STREAM_PLAYLISTS)}
                      onChange={(e) =>
                        setForm({ ...form, playlists: e.target.checked ? [...form.playlists, { id: p.id, title: p.title }] : form.playlists.filter((x) => x.id !== p.id) })
                      }
                    />
                    <span>{p.title || p.id}</span>
                    {!known && playlists !== null && <span className="text-xs text-amber-300">{t("live.video.playlistMissing")}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-zinc-500">{t("live.video.playlistsHint", { max: String(MAX_STREAM_PLAYLISTS) })}</p>
      </section>

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.broadcast")}</h4>
        <p className="text-xs text-zinc-500">{t("live.video.broadcastNote")}</p>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("live.video.field.latency")}
          <select
            value={form.broadcast.latencyPreference}
            onChange={(e) => setForm({ ...form, broadcast: { ...form.broadcast, latencyPreference: e.target.value as LiveLatency } })}
            disabled={busy}
            className={`${inputClass} max-w-xs`}
          >
            {LIVE_LATENCIES.map((latency) => (
              <option key={latency} value={latency}>
                {t(LATENCY_KEYS[latency])}
              </option>
            ))}
          </select>
          <span className="text-zinc-500">{t("live.video.hint.latency")}</span>
        </label>
        <div className="flex items-start gap-2">
          <ToggleSwitch tone="violet" label={t("live.video.field.dvr")} checked={form.broadcast.enableDvr} onChange={(checked) => setForm({ ...form, broadcast: { ...form.broadcast, enableDvr: checked } })} disabled={busy} />
          <div>
            <p className="text-sm text-zinc-300">{t("live.video.field.dvr")}</p>
            <p className="text-xs text-zinc-500">{t("live.video.hint.dvr")}</p>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <ToggleSwitch tone="violet" label={t("live.video.field.embed")} checked={form.broadcast.enableEmbed} onChange={(checked) => setForm({ ...form, broadcast: { ...form.broadcast, enableEmbed: checked } })} disabled={busy} />
          <div>
            <p className="text-sm text-zinc-300">{t("live.video.field.embed")}</p>
            <p className="text-xs text-zinc-500">{t("live.video.hint.embed")}</p>
          </div>
        </div>
        <p className="text-sm text-zinc-300">
          {t("live.video.field.captions")}: <span className="text-zinc-400">{t("live.video.captionsOff")}</span>
        </p>
        <p className="text-xs text-zinc-500">{t("live.video.hint.captions")}</p>
      </section>

      <section className={sectionClass}>
        <h4 className={sectionTitleClass}>{t("live.video.section.studioOnly")}</h4>
        <p className="text-xs text-zinc-500">{t("live.video.studioOnlyNote")}</p>
        <ul className="list-inside list-disc text-xs text-zinc-400">
          {LIVE_STUDIO_ONLY_FIELDS.map((field) => (
            <li key={field}>{t(STUDIO_ONLY_KEYS[field])}</li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
        <button type="button" onClick={save} disabled={busy || !valid || (!dirty && saved !== null)} className={primaryClass}>
          {t("live.video.save")}
        </button>
        {dirty && <span className="text-xs text-amber-300">{t("live.video.unsaved")}</span>}
        {busy && <LoadingIndicator className="text-xs text-zinc-400" />}
        {error && <span className="text-xs text-red-400">{error}</span>}
        {notice && !dirty && <span className="text-xs text-emerald-400">{notice}</span>}
      </div>
    </div>
  );
}
