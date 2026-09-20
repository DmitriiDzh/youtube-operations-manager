"use client";

import { useCallback, useEffect, useState } from "react";

type EditorialContext = {
  targetAudience?: string;
  toneNotes?: string;
  terminologyNotes?: string;
  titleConstraints?: string;
  descriptionConstraints?: string;
};

type EditorialProfile = {
  channelId: string;
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

const FIELDS = [
  ["targetAudience", "Target audience"],
  ["toneNotes", "Tone & style guidance"],
  ["terminologyNotes", "Preferred terminology"],
  ["titleConstraints", "Title constraints"],
  ["descriptionConstraints", "Description constraints"],
] as const;

/**
 * Relocated from the former "AI Localization" tab onto Home (docs/roadmap/plans/
 * STUDIO_PARITY_PLAN.md Slice S4, per the owner's own framing: "звучит как что-то
 * фундаментальное. И то что редко меняется") -- open, edit, save, close. Same editor, same
 * API routes, just moved; not redesigned. Channel-scoped, so it resolves the single active
 * channel itself (docs/decisions/0004-active-channel-read-scoping.md) rather than taking one
 * as a prop.
 */
export function EditorialProfilePanel() {
  const [channelId, setChannelId] = useState("");
  const [profile, setProfile] = useState<EditorialProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<EditorialContext>({});
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/channels");
      const data = await res.json();
      if (res.ok && data.channels?.[0]) setChannelId(data.channels[0].channelId);
    })();
  }, []);

  const fetchProfile = useCallback(async () => {
    if (!channelId) return;
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/ai-localization/profile`);
    if (!res.ok) return;
    const data = await res.json();
    setProfile(data.profile);
    setProfileDraft(
      data.profile
        ? {
            targetAudience: data.profile.targetAudience ?? undefined,
            toneNotes: data.profile.toneNotes ?? undefined,
            terminologyNotes: data.profile.terminologyNotes ?? undefined,
            titleConstraints: data.profile.titleConstraints ?? undefined,
            descriptionConstraints: data.profile.descriptionConstraints ?? undefined,
          }
        : {}
    );
  }, [channelId]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      // WYSIWYG: every field currently shown is sent, with an emptied textarea sent as an
      // explicit `null` (clear that field) rather than omitted (leave unchanged) -- omission
      // only ever happens for a field this form never loaded.
      const payload = Object.fromEntries(
        Object.entries(profileDraft).map(([key, value]) => [key, value === "" ? null : value])
      );
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/ai-localization/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save editorial profile");
        return;
      }
      setProfile(data.profile);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-sm font-medium text-zinc-200"
      >
        <span>Channel editorial profile {profile ? `(v${profile.version})` : "(none saved)"}</span>
        <span className="text-xs text-zinc-500">{open ? "Hide" : "Edit"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-zinc-800 p-4">
          <p className="text-xs text-zinc-500">
            Optional, per-channel guidance automatically applied whenever AI generates a
            localization proposal for this channel. Never required; a channel with no saved
            profile generates normally.
          </p>
          {FIELDS.map(([field, label]) => (
            <label key={field} className="block">
              <span className="text-xs text-zinc-400">{label}</span>
              <textarea
                value={profileDraft[field] ?? ""}
                onChange={(e) => setProfileDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                rows={2}
              />
            </label>
          ))}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-zinc-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save profile"}
          </button>
        </div>
      )}
    </div>
  );
}
