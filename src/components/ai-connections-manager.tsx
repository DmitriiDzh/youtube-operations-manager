"use client";

import { useCallback, useEffect, useState } from "react";

type Connection = {
  id: string;
  displayName: string;
  adapterType: "mock" | "openai_compatible";
  baseUrl: string | null;
  modelId: string;
  localInferenceMode: boolean;
  enabled: boolean;
  status: "unknown" | "ok" | "error";
  statusMessage: string | null;
  capabilities: { structuredOutput: "json_schema" | "json_object" | "none" };
  hasCredential: boolean;
};

type DraftConnection = {
  displayName: string;
  adapterType: "mock" | "openai_compatible";
  baseUrl: string;
  modelId: string;
  localInferenceMode: boolean;
  structuredOutput: "json_schema" | "json_object" | "none";
  apiKey: string;
};

const EMPTY_DRAFT: DraftConnection = {
  displayName: "",
  adapterType: "openai_compatible",
  baseUrl: "",
  modelId: "",
  localInferenceMode: false,
  structuredOutput: "json_object",
  apiKey: "",
};

export function AiConnectionsManager() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftConnection>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string; mayIncurCost: boolean }>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [confirmCostFor, setConfirmCostFor] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    const res = await fetch("/api/ai-connections");
    if (!res.ok) return;
    const data = await res.json();
    setConnections(data.connections ?? []);
  }, []);

  useEffect(() => {
    void fetchConnections();
  }, [fetchConnections]);

  async function handleCreate() {
    setError(null);
    if (!draft.displayName || !draft.modelId) {
      setError("Display name and model id are required");
      return;
    }
    if (draft.adapterType === "openai_compatible" && !draft.baseUrl) {
      setError("Base URL is required for an OpenAI-compatible connection");
      return;
    }

    setCreating(true);
    try {
      const res = await fetch("/api/ai-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: draft.displayName,
          adapterType: draft.adapterType,
          baseUrl: draft.adapterType === "openai_compatible" ? draft.baseUrl : null,
          modelId: draft.modelId,
          localInferenceMode: draft.localInferenceMode,
          capabilities: { structuredOutput: draft.structuredOutput },
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to create connection");
        return;
      }
      setDraft(EMPTY_DRAFT);
      await fetchConnections();
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleEnabled(connection: Connection) {
    await fetch(`/api/ai-connections/${encodeURIComponent(connection.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !connection.enabled }),
    });
    await fetchConnections();
  }

  async function handleDelete(connection: Connection) {
    await fetch(`/api/ai-connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    await fetchConnections();
  }

  async function handleClearCredential(connection: Connection) {
    await fetch(`/api/ai-connections/${encodeURIComponent(connection.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: null }),
    });
    await fetchConnections();
  }

  async function handleTest(connection: Connection) {
    setTestingId(connection.id);
    setConfirmCostFor(null);
    try {
      const res = await fetch(`/api/ai-connections/${encodeURIComponent(connection.id)}/test`, { method: "POST" });
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, [connection.id]: data }));
      await fetchConnections();
    } finally {
      setTestingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-800 p-4">
        <h3 className="mb-3 text-sm font-semibold text-zinc-200">New connection</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-zinc-400">Display name</span>
            <input
              value={draft.displayName}
              onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Adapter type</span>
            <select
              value={draft.adapterType}
              onChange={(e) => setDraft((d) => ({ ...d, adapterType: e.target.value as DraftConnection["adapterType"] }))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            >
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="mock">Mock (deterministic, no network)</option>
            </select>
          </label>
          {draft.adapterType === "openai_compatible" && (
            <>
              <label className="block">
                <span className="text-xs text-zinc-400">Base URL</span>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">Structured output</span>
                <select
                  value={draft.structuredOutput}
                  onChange={(e) => setDraft((d) => ({ ...d, structuredOutput: e.target.value as DraftConnection["structuredOutput"] }))}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                >
                  <option value="json_object">json_object</option>
                  <option value="json_schema">json_schema</option>
                  <option value="none">none (unsupported -- generation will error)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={draft.localInferenceMode} onChange={(e) => setDraft((d) => ({ ...d, localInferenceMode: e.target.checked }))} />
                Local-inference mode (allows localhost/private-network Base URL; only enable for a trusted local server)
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">API key (optional, never shown again once saved)</span>
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                />
              </label>
            </>
          )}
          <label className="block">
            <span className="text-xs text-zinc-400">Model id</span>
            <input
              value={draft.modelId}
              onChange={(e) => setDraft((d) => ({ ...d, modelId: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-3 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {creating ? "Creating..." : "Create connection"}
        </button>
      </div>

      <div className="space-y-3">
        {connections.map((c) => (
          <div key={c.id} className="rounded-lg border border-zinc-800 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-zinc-200">
                  {c.displayName} <span className="text-xs text-zinc-500">({c.adapterType})</span>
                </p>
                <p className="text-xs text-zinc-500">
                  {c.modelId} {c.baseUrl ? `→ ${c.baseUrl}` : ""} {c.localInferenceMode ? "• local-inference mode" : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  Credential: {c.hasCredential ? "configured" : "none"} • Status: {c.status}
                  {c.statusMessage ? ` (${c.statusMessage})` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggleEnabled(c)} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                {c.hasCredential && (
                  <button onClick={() => handleClearCredential(c)} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                    Clear credential
                  </button>
                )}
                <button onClick={() => handleDelete(c)} className="rounded-md border border-red-800 px-3 py-1 text-xs text-red-400 hover:bg-red-950/30">
                  Delete
                </button>
              </div>
            </div>

            <div className="mt-3">
              {confirmCostFor === c.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-300">
                    {c.adapterType === "mock" ? "This will not incur any cost." : "This will make a real request to the configured endpoint and may incur cost."}
                  </span>
                  <button onClick={() => handleTest(c)} className="rounded-md bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600">
                    Confirm and test
                  </button>
                  <button onClick={() => setConfirmCostFor(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmCostFor(c.id)}
                  disabled={testingId === c.id}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {testingId === c.id ? "Testing..." : "Test connection"}
                </button>
              )}
              {testResults[c.id] && (
                <p className={`mt-2 text-xs ${testResults[c.id].ok ? "text-emerald-400" : "text-red-400"}`}>{testResults[c.id].message}</p>
              )}
            </div>
          </div>
        ))}
        {connections.length === 0 && <p className="text-sm text-zinc-500">No connections configured yet.</p>}
      </div>
    </div>
  );
}
