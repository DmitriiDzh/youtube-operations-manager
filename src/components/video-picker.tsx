"use client";

import { useEffect, useState } from "react";
import { errorText } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";
import type { VideoListView } from "./video-projects-panel";

// BL-194 stage 1 (VIDEO_COST_PLAN.md §2 "UI"): the video a storyboard or a plan is for -- the channel's videos in work or packaged
// (a number in dispute cannot be chosen), or «не привязано». The choice is saved at once through `onChange`; a refusal is shown here.

export function VideoPicker({ channelId, value, onChange, disabled }: { channelId: string; value: string | null; onChange: (video: string | null) => Promise<Response>; disabled?: boolean }) {
  const { t } = useUiText();
  const [list, setList] = useState<VideoListView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/video-projects`);
        if (res.ok && live) setList((await res.json()) as VideoListView);
      } catch {
        // The picker still shows the current value; choosing waits for the list.
      }
    })();
    return () => {
      live = false;
    };
  }, [channelId]);

  const options = (list?.videos ?? []).filter((v) => (v.state === "in_work" || v.state === "packaged") && !v.conflict);
  const known = value === null || options.some((v) => v.video === value);

  async function choose(next: string | null) {
    setSaving(true);
    try {
      const res = await onChange(next);
      if (!res.ok) throw new Error(errorText(t, await res.json().catch(() => null), t("videoPicker.saveFailed")));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("videoPicker.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-zinc-400">
      <label className="inline-flex items-center gap-2">
        <span>{t("videoPicker.label")}</span>
        <select
          value={value ?? ""}
          disabled={disabled || saving || !list}
          onChange={(e) => void choose(e.target.value === "" ? null : e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 disabled:opacity-50"
        >
          <option value="">{t("videoPicker.none")}</option>
          {!known && value && <option value={value}>{value}</option>}
          {options.map((v) => (
            <option key={v.video} value={v.video}>
              {v.workingTitle ? t("videoPicker.option", { video: v.video, title: v.workingTitle }) : v.video}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="text-red-400">{error}</span>}
    </span>
  );
}
