"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

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

const STATUS_LABEL: Record<Connection["status"], UiTextKey> = {
  unknown: "settingsCards.ai.status.unknown",
  ok: "settingsCards.ai.status.ok",
  error: "settingsCards.ai.status.error",
};

export function AiConnectionsManager() {
  const t = useT();
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
      setError(t("settingsCards.ai.nameModelRequired"));
      return;
    }
    if (draft.adapterType === "openai_compatible" && !draft.baseUrl) {
      setError(t("settingsCards.ai.baseUrlRequired"));
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
        setError(errorText(t, data, t("settingsCards.ai.createFailed"), { showErrorField: false }));
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
        <h3 className="mb-3 text-sm font-semibold text-zinc-200">{t("settingsCards.ai.newTitle")}</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-zinc-400">{t("settingsCards.ai.displayName")}</span>
            <input
              value={draft.displayName}
              onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">{t("settingsCards.ai.adapterType")}</span>
            <select
              value={draft.adapterType}
              onChange={(e) => setDraft((d) => ({ ...d, adapterType: e.target.value as DraftConnection["adapterType"] }))}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            >
              {/* ui-text-ignore: a product/protocol name, the same in every language. */}
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="mock">{t("settingsCards.ai.mockOption")}</option>
            </select>
          </label>
          {draft.adapterType === "openai_compatible" && (
            <>
              <label className="block">
                <span className="text-xs text-zinc-400">{t("settingsCards.ai.baseUrl")}</span>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                />
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">{t("settingsCards.ai.structuredOutput")}</span>
                <select
                  value={draft.structuredOutput}
                  onChange={(e) => setDraft((d) => ({ ...d, structuredOutput: e.target.value as DraftConnection["structuredOutput"] }))}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
                >
                  {/* ui-text-ignore: API format names, the same in every language. */}
                  <option value="json_object">json_object</option>
                  {/* ui-text-ignore: API format names, the same in every language. */}
                  <option value="json_schema">json_schema</option>
                  <option value="none">{t("settingsCards.ai.structuredNone")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <input type="checkbox" checked={draft.localInferenceMode} onChange={(e) => setDraft((d) => ({ ...d, localInferenceMode: e.target.checked }))} />
                {t("settingsCards.ai.localInference")}
              </label>
              <label className="block">
                <span className="text-xs text-zinc-400">{t("settingsCards.ai.apiKey")}</span>
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
            <span className="text-xs text-zinc-400">{t("settingsCards.ai.modelId")}</span>
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
          {creating ? t("settingsCards.ai.creating") : t("settingsCards.ai.create")}
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
                  {c.modelId} {c.baseUrl ? `→ ${c.baseUrl}` : ""} {c.localInferenceMode ? t("settingsCards.ai.localInferenceBadge") : ""}
                </p>
                <p className="text-xs text-zinc-500">
                  {t("settingsCards.ai.credentialStatus", {
                    credential: c.hasCredential ? t("settingsCards.ai.credentialConfigured") : t("value.none"),
                    status: t(STATUS_LABEL[c.status]),
                  })}
                  {c.statusMessage ? ` (${c.statusMessage})` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => handleToggleEnabled(c)} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                  {c.enabled ? t("settingsCards.ai.disable") : t("settingsCards.enable")}
                </button>
                {c.hasCredential && (
                  <button onClick={() => handleClearCredential(c)} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
                    {t("settingsCards.ai.clearCredential")}
                  </button>
                )}
                <button onClick={() => handleDelete(c)} className="rounded-md border border-red-800 px-3 py-1 text-xs text-red-400 hover:bg-red-950/30">
                  {t("settingsCards.ai.delete")}
                </button>
              </div>
            </div>

            <div className="mt-3">
              {confirmCostFor === c.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-300">
                    {c.adapterType === "mock" ? t("settingsCards.ai.noCost") : t("settingsCards.ai.mayCost")}
                  </span>
                  <button onClick={() => handleTest(c)} className="rounded-md bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-600">
                    {t("settingsCards.ai.confirmTest")}
                  </button>
                  <button onClick={() => setConfirmCostFor(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
                    {t("common.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmCostFor(c.id)}
                  disabled={testingId === c.id}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {testingId === c.id ? t("settingsCards.ai.testing") : t("settingsCards.ai.test")}
                </button>
              )}
              {testResults[c.id] && (
                <p className={`mt-2 text-xs ${testResults[c.id].ok ? "text-emerald-400" : "text-red-400"}`}>{testResults[c.id].message}</p>
              )}
            </div>
          </div>
        ))}
        {connections.length === 0 && <p className="text-sm text-zinc-500">{t("settingsCards.ai.none")}</p>}
      </div>
    </div>
  );
}
