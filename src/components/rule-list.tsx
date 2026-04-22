"use client";

type Rule = {
  id: number;
  name: string;
  matchField: string;
  matchType: string;
  matchValue: string;
  playlistTitle: string;
  enabled: boolean;
};

export function RuleList({
  rules,
  onDelete,
}: {
  rules: Rule[];
  onDelete: (id: number) => void;
}) {
  if (rules.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
        No rules yet. Create one above to get started.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rules.map((rule) => (
        <div
          key={rule.id}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div>
            <p className="font-medium">{rule.name}</p>
            <p className="text-sm text-zinc-500">
              If{" "}
              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                {rule.matchField}
              </span>{" "}
              <span className="text-zinc-400">{rule.matchType}</span>{" "}
              <span className="font-mono text-red-600 dark:text-red-400">
                &quot;{rule.matchValue}&quot;
              </span>{" "}
              → add to{" "}
              <span className="font-semibold">{rule.playlistTitle}</span>
            </p>
          </div>
          <button
            onClick={() => onDelete(rule.id)}
            className="rounded-lg px-3 py-1 text-sm text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
