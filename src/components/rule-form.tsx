"use client";

import { useState, useEffect } from "react";

type Playlist = { id: string; title: string };

export function RuleForm({ onCreated }: { onCreated: () => void }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    matchField: "title",
    matchType: "contains",
    matchValue: "",
    playlistId: "",
  });

  useEffect(() => {
    fetch("/api/youtube/playlists")
      .then((r) => r.json())
      .then(setPlaylists);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const playlist = playlists.find((p) => p.id === form.playlistId);

    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        playlistTitle: playlist?.title ?? "",
      }),
    });

    setForm({
      name: "",
      matchField: "title",
      matchType: "contains",
      matchValue: "",
      playlistId: "",
    });
    setLoading(false);
    onCreated();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="mb-4 text-lg font-semibold">New Rule</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-sm font-medium">Rule Name</label>
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder='e.g. "Podcasts to playlist"'
            className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Match Field</label>
          <select
            value={form.matchField}
            onChange={(e) => setForm({ ...form, matchField: e.target.value })}
            className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            <option value="title">Title</option>
            <option value="description">Description</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Match Type</label>
          <select
            value={form.matchType}
            onChange={(e) => setForm({ ...form, matchType: e.target.value })}
            className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            <option value="contains">Contains</option>
            <option value="startsWith">Starts With</option>
            <option value="endsWith">Ends With</option>
            <option value="equals">Equals</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Match Value</label>
          <input
            type="text"
            required
            value={form.matchValue}
            onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
            placeholder='e.g. "Podcast"'
            className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">
            Target Playlist
          </label>
          <select
            required
            value={form.playlistId}
            onChange={(e) => setForm({ ...form, playlistId: e.target.value })}
            className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
          >
            <option value="">Select a playlist...</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? "Creating..." : "Create Rule"}
      </button>
    </form>
  );
}
