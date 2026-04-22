"use client";

import { useState } from "react";

type RunResult = {
  matched: number;
  results?: { video: string; playlist: string; rule: string }[];
  message?: string;
};

export function RunButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  async function handleRun() {
    setLoading(true);
    setResult(null);

    const res = await fetch("/api/run", { method: "POST" });
    const data = await res.json();
    setResult(data);
    setLoading(false);
  }

  return (
    <div>
      <button
        onClick={handleRun}
        disabled={loading}
        className="rounded-lg bg-green-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? "Running rules..." : "Run Rules Now"}
      </button>

      {result && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          {result.matched === 0 ? (
            <p className="text-sm text-zinc-500">
              {result.message ?? "No videos matched any rules."}
            </p>
          ) : (
            <>
              <p className="mb-2 text-sm font-medium text-green-600">
                {result.matched} video(s) matched and added!
              </p>
              <ul className="space-y-1 text-sm">
                {result.results?.map((r, i) => (
                  <li key={i} className="text-zinc-600 dark:text-zinc-400">
                    <span className="font-medium">{r.video}</span> → {r.playlist}{" "}
                    <span className="text-zinc-400">(rule: {r.rule})</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
