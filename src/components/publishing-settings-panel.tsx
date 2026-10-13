"use client";

import { useCallback, useEffect, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { isValidLocalTimeOfDay } from "@/lib/zoned-time";
// The pure fields module (no server code): the same lists and types the server validates with.
import { CHANNEL_TAGS_MAX, PUBLISHING_LICENSES, VIDEO_CATEGORY_IDS, type PublishingSettings as Settings } from "@/lib/publishing/settings";
import { tagsLength } from "@/lib/publishing/packages";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";
import { UtcTimeField } from "./utc-time-field";

type View = { settings: Settings; saved: string[]; conflictedFields: string[] };
type Playlist = { id: string; title: string };

const FLAGS: Array<{ field: "containsSyntheticMedia" | "madeForKids" | "embeddable" | "notifySubscribers" | "paidProductPlacement"; label: UiTextKey }> = [
  { field: "containsSyntheticMedia", label: "publishingSettings.field.containsSyntheticMedia" },
  { field: "madeForKids", label: "publishingSettings.field.madeForKids" },
  { field: "embeddable", label: "publishingSettings.field.embeddable" },
  { field: "notifySubscribers", label: "publishingSettings.field.notifySubscribers" },
  // Owner msgs 2751/2753: Studio's «Прямая реклама».
  { field: "paidProductPlacement", label: "publishingSettings.field.paidProductPlacement" },
];

/** The channel tags as typed: comma-separated, trimmed, empty ones dropped, each once (case-insensitive). */
export function parseChannelTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/**
 * BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; owner msg 2715: "дефолтные значения для метаданных ... достаточно выбрать
 * один раз"): the channel's publishing defaults, shared by both computers. Every upload of the channel gets them; only a video's
 * title, description and thumbnail come from its package. The publish time is a UTC time with the owner's own time beside it
 * (owner msgs 2725/2727). Only the fields the owner changed are sent, so a value that arrived from the other computer after this
 * screen loaded is never overwritten by this screen's stale copy.
 */
export function PublishingSettingsPanel({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const t = useT();
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [playlistsError, setPlaylistsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [tagsText, setTagsText] = useState("");

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing-settings`);
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("publishingSettings.loadFailed")));
      setView(data);
      setDraft(data.settings);
      setTagsText((data.settings.channelTags ?? []).join(", "));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingSettings.loadFailed"));
    }
  }, [channelId, t]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  // The channel's playlists (one Data API read, only once the tab is shown): the picker offers them by name.
  useEffect(() => {
    if (!visible || !channelId || playlists !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/youtube/playlists");
        const data = await res.json();
        if (!res.ok) throw new Error(errorText(t, data, t("publishingSettings.loadFailed")));
        if (!cancelled) setPlaylists((data as Playlist[]).map((p) => ({ id: p.id, title: p.title })));
      } catch (e) {
        if (!cancelled) {
          setPlaylists([]);
          setPlaylistsError(e instanceof Error ? e.message : t("publishingSettings.loadFailed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, channelId, playlists, t]);

  if (!channelId) return null;
  if (!view || !draft) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {error ? <p className="text-sm text-red-400">{error}</p> : <LoadingIndicator className="text-sm text-zinc-400" />}
      </div>
    );
  }

  const changed = (Object.keys(draft) as Array<keyof Settings>).filter((field) => JSON.stringify(draft[field]) !== JSON.stringify(view.settings[field]));
  const timeValid = isValidLocalTimeOfDay(draft.publishTimeUtc);
  const channelTags = draft.channelTags ?? [];
  const tagsChars = tagsLength(channelTags);
  const tagsProblem =
    channelTags.length > CHANNEL_TAGS_MAX
      ? t("publishingSettings.channelTags.tooMany", { max: CHANNEL_TAGS_MAX })
      : channelTags.some((tag) => tag.length > 100 || /[<>]/.test(tag))
        ? t("publishingSettings.channelTags.badTag")
        : tagsChars > 500
          ? t("publishingSettings.channelTags.tooLong")
          : null;

  async function save() {
    if (!draft || !view || !channelId) return;
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      const body = Object.fromEntries(changed.map((field) => [field, draft[field]]));
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(t, data, t("publishingSettings.saveFailed")));
      setView(data);
      setDraft(data.settings);
      setTagsText((data.settings.channelTags ?? []).join(", "));
      setSavedNotice(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingSettings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const selectClass = "rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100";
  const knownPlaylist = draft.playlistId === null || (playlists ?? []).some((p) => p.id === draft.playlistId);

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("publishingSettings.title")}
          <InfoTooltip>{t("publishingSettings.languageNote")}</InfoTooltip>
        </h3>
        <p className="mt-1 text-xs text-zinc-400">{t("publishingSettings.intro")}</p>
      </div>
      {view.conflictedFields.length > 0 && (
        <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{t("publishingSettings.differsBetweenComputers")}</p>
      )}
      {view.saved.length === 0 && <p className="text-xs text-zinc-500">{t("publishingSettings.notSavedYet")}</p>}

      <div className="flex flex-wrap items-start gap-4">
        <div className="space-y-1">
          <UtcTimeField
            label={t("publishingSettings.field.publishTimeUtc")}
            value={draft.publishTimeUtc}
            onChange={(value) => setDraft({ ...draft, publishTimeUtc: value })}
            invalid={!timeValid}
          />
          <p className="text-xs text-zinc-500">{t("publishingSettings.publishTimeHint")}</p>
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("publishingSettings.field.playlistId")}
          <select value={draft.playlistId ?? ""} onChange={(e) => setDraft({ ...draft, playlistId: e.target.value || null })} className={selectClass}>
            <option value="">{t("publishingSettings.playlistNone")}</option>
            {!knownPlaylist && draft.playlistId && <option value={draft.playlistId}>{t("publishingSettings.playlistUnknown", { id: draft.playlistId })}</option>}
            {(playlists ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          {playlistsError && <span className="text-xs text-amber-300">{t("publishingSettings.playlistsUnavailable", { message: playlistsError })}</span>}
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("publishingSettings.field.categoryId")}
          <select value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })} className={selectClass}>
            {VIDEO_CATEGORY_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`publishingSettings.category.${id}` as UiTextKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {t("publishingSettings.field.license")}
          <select value={draft.license} onChange={(e) => setDraft({ ...draft, license: e.target.value as Settings["license"] })} className={selectClass}>
            {PUBLISHING_LICENSES.map((license) => (
              <option key={license} value={license}>
                {t(`publishingSettings.license.${license}` as UiTextKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {FLAGS.map(({ field, label }) => (
          <div key={field} className="flex items-center gap-2">
            <ToggleSwitch tone="violet" label={t(label)} checked={draft[field]} onChange={(checked) => setDraft({ ...draft, [field]: checked })} />
            <span className="text-sm text-zinc-300">{t(label)}</span>
          </div>
        ))}
      </div>

      <label className="flex max-w-3xl flex-col gap-1 text-xs text-zinc-400">
        {t("publishingSettings.channelTags.label")}
        <input
          type="text"
          value={tagsText}
          onChange={(e) => {
            setTagsText(e.target.value);
            setDraft({ ...draft, channelTags: parseChannelTags(e.target.value) });
          }}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
        />
        <span className={tagsProblem ? "text-red-400" : "text-zinc-500"}>
          {tagsProblem ?? t("publishingSettings.channelTags.hint", { count: channelTags.length, chars: tagsChars })}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || changed.length === 0 || !timeValid || tagsProblem !== null}
          className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("publishingSettings.save")}
        </button>
        {!timeValid && <span className="text-xs text-red-400">{t("publishingSettings.invalidTime")}</span>}
        {savedNotice && changed.length === 0 && <span className="text-xs font-medium text-green-500">{t("common.saved")}</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
