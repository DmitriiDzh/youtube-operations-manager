"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";

/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.5, AC-P12-10) -- "Operator CLI access":
 * whether the CLI may run WITHOUT an agent token, as the operator. Off by default and persistent.
 * While it is off, a shell-capable agent cannot bypass its channel binding by simply omitting its
 * token. Same fetch/save shape as `mcp-connection-settings.tsx` (`/api/settings` applies only the
 * fields present in a POST body).
 */
export function OperatorCliSettings() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as { operatorCliEnabled: boolean };
    if (ownSettingsUnavailable(data, ["operatorCliEnabled"])) return;
    setSaved(data.operatorCliEnabled);
    setDraft(data.operatorCliEnabled);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorCliEnabled: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setSaved(data.operatorCliEnabled);
      setDraft(data.operatorCliEnabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (draft === null) return null;
  const dirty = draft !== saved;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Operator CLI access
          <InfoTooltip>
            Off by default. While it is off, the command-line tool only works with a channel&apos;s agent token
            (YTOM_AGENT_TOKEN), and then only for that channel. Turn it on only while you use the CLI
            yourself, for example `auth login` or `asset register`. While it is on, anything on this computer that
            can run the CLI without a token has full operator access to every channel.
          </InfoTooltip>
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch
            label="Allow the CLI without an agent token"
            checked={draft}
            onChange={(checked) => (checked ? setConfirming(true) : setDraft(false))}
          />
          <span className="text-sm text-zinc-300">Allow the CLI without an agent token</span>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save / Apply"}
        </button>
        {dirty && (
          <button onClick={() => setDraft(saved)} className="text-xs text-zinc-500 hover:text-zinc-300">
            Discard changes
          </button>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Allow the CLI without an agent token?"
          description="Any process on this computer that runs the CLI without a token will act as the operator, across every channel. The channel wall between agents does not apply to it. Turn this back off when you are done."
          confirmLabel="Allow"
          confirmVariant="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setDraft(true);
          }}
        />
      )}
    </div>
  );
}
