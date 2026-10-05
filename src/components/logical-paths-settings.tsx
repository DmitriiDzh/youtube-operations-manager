"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";

type LogicalPathEntry = {
  name: string;
  audience: "all_agents" | "factory_only";
  description: string;
  path: string | null;
  status: "exists" | "missing" | null;
  updatedAt: string | null;
};

type ApiError = { message?: string };

const AUDIENCE_LABEL: Record<LogicalPathEntry["audience"], string> = {
  all_agents: "all agents (read-only)",
  factory_only: "Factory Operator only",
};

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` F1) -- Settings card for the
 * registry of logical paths. Each machine configures only ITS OWN values (owner decision, 2026-10-05):
 * the value shown and edited here is this computer's, stored only on this device. The folder status is
 * a one-time check of this computer's stored path; agents are only ever given the stored string. Plain
 * controlled inputs and a two-step delete, no native dialogs. Self-contained (`AGENTS.md` §M): it owns
 * its own fetch/save against `/api/logical-paths` and is wrapped in its own error boundary by the caller.
 */
export function LogicalPathsSettings() {
  const [paths, setPaths] = useState<LogicalPathEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/logical-paths");
      if (!res.ok) throw new Error("load failed");
      setPaths(((await res.json()) as { paths: LogicalPathEntry[] }).paths);
    } catch {
      setLoadError("Could not load the logical paths.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return (
      <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-red-400">
        <p>{loadError}</p>
        <button onClick={() => load()} className="underline hover:text-red-300">
          Retry
        </button>
      </div>
    );
  }

  if (!paths) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <LoadingIndicator className="text-sm text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        Logical paths (this computer)
        <InfoTooltip>
          Named folders that connected agents can look up by name. The same name usually points to a
          different folder on each computer, so every computer keeps only its own value: nothing here
          is synced or handed off. Agents are given just the stored path text; this app never opens,
          lists or changes anything inside a folder. &ldquo;All agents&rdquo; paths can be read by every
          channel agent, &ldquo;Factory Operator only&rdquo; paths only by the Factory Operator role.
          Agents can never create, change or delete a path. A folder must exist and must not be inside
          this app&apos;s own data directory.
        </InfoTooltip>
      </h3>

      <ul className="space-y-3">
        {paths.map((entry) => (
          <LogicalPathRow key={entry.name} entry={entry} onChanged={load} />
        ))}
      </ul>

      <CreateLogicalPathForm onCreated={load} />
    </div>
  );
}

function LogicalPathRow({ entry, onChanged }: { entry: LogicalPathEntry; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(entry.path ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Resync the draft when the stored value changes (another tab, or a reload after save) so a stale draft cannot overwrite it.
  useEffect(() => {
    setDraft(entry.path ?? "");
  }, [entry.path]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (entry.path ?? "");

  async function call(url: string, method: string, body: unknown, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        setError(((await res.json()) as ApiError).message ?? "Request failed");
        return false;
      }
      setNotice(success);
      await onChanged();
      return true;
    } catch {
      setError("Request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(next: string | null) {
    const ok = await call("/api/logical-paths/value", "PUT", { name: entry.name, path: next }, next ? "Saved." : "Cleared.");
    if (ok && next === null) setDraft("");
  }

  return (
    <li className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-mono text-sm text-zinc-100">{entry.name}</span>
          <span className="ml-2 text-xs text-zinc-500">{AUDIENCE_LABEL[entry.audience]}</span>
        </div>
        {entry.status === "exists" && <span className="text-xs text-green-500">folder exists</span>}
        {entry.status === "missing" && <span className="text-xs text-amber-400">folder not found on this computer</span>}
        {entry.status === null && <span className="text-xs text-zinc-500">not set on this computer</span>}
      </div>
      {entry.description && <p className="text-xs text-zinc-400">{entry.description}</p>}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-zinc-400">
          Folder on this computer
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="/absolute/path/to/folder"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <button
          onClick={() => save(trimmed === "" ? null : trimmed)}
          disabled={busy || !dirty}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save"}
        </button>
        {entry.path && (
          <button
            onClick={() => save(null)}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Clear
          </button>
        )}
        {!confirmingDelete ? (
          <button
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-red-700 hover:text-red-400 disabled:opacity-50"
          >
            Delete path
          </button>
        ) : (
          <span role="alertdialog" aria-label={`Delete logical path ${entry.name}`} className="flex items-center gap-2 text-xs text-red-400">
            Remove this name and its value?
            <button
              onClick={() => call("/api/logical-paths", "DELETE", { name: entry.name }, "Deleted.")}
              disabled={busy}
              className="rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              Yes, delete
            </button>
            <button onClick={() => setConfirmingDelete(false)} className="underline hover:text-red-300">
              Cancel
            </button>
          </span>
        )}
      </div>
      {notice && <p role="status" className="text-xs text-green-500">{notice}</p>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </li>
  );
}

function CreateLogicalPathForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<LogicalPathEntry["audience"]>("all_agents");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/logical-paths", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), audience, description: description.trim() }),
      });
      if (!res.ok) {
        setError(((await res.json()) as ApiError).message ?? "Failed to create");
        return;
      }
      setName("");
      setDescription("");
      await onCreated();
    } catch {
      setError("Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-2 border-t border-zinc-800 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && name.trim() !== "") void create();
      }}
    >
      <p className="text-xs font-medium text-zinc-300">Add a logical path</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="script_library"
            className="w-48 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Visible to
          <select
            value={audience}
            onChange={(e) => setAudience(e.target.value as LogicalPathEntry["audience"])}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          >
            <option value="all_agents">{AUDIENCE_LABEL.all_agents}</option>
            <option value="factory_only">{AUDIENCE_LABEL.factory_only}</option>
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-zinc-400">
          Description (optional)
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? "Adding..." : "Add"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Name: 2&ndash;64 characters, lowercase letters, digits and underscore, starting with a letter. The
        value is set separately, on each computer.
      </p>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </form>
  );
}
