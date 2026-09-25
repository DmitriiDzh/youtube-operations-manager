"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";

type AgentConnection = {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: string;
};

type AgentCapabilityZone = {
  capabilityId: string;
  assignedConnectionId: string | null;
};

/**
 * BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- these 6 are exactly the capabilities wired
 * to `assertAgentAllowedForCapability` in src/mcp/server.ts/src/cli/video-metadata.ts (slice 2).
 * Kept as a hardcoded list here (not fetched from the backend) because src/lib/agent-connections/
 * deliberately does not know about any capability registry (AGENTS.md §M) -- this list must be
 * kept in sync by hand with the actual `zoneCapabilityId`/`assertAgentAllowedForCapability` call
 * sites if either changes.
 */
const ZONEABLE_CAPABILITIES: { capabilityId: string; label: string; domain: string }[] = [
  { capabilityId: "channel_sync", label: "Sync channel from YouTube", domain: "Channel sync" },
  { capabilityId: "changeset_create_from_import", label: "Create Change Set from XLSX import", domain: "Localization" },
  { capabilityId: "ai_localization_generate", label: "Generate AI localization proposals", domain: "Localization" },
  { capabilityId: "ai_localization_create_change_set", label: "Create Change Set from AI generation", domain: "Localization" },
  { capabilityId: "content_proposal.create_content_proposal", label: "Create Content Proposal", domain: "Content proposals" },
  { capabilityId: "content_proposal.register_external_artifact", label: "Register external artifact", domain: "Content proposals" },
];

export function AgentConnectionsManager() {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [zones, setZones] = useState<AgentCapabilityZone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [registering, setRegistering] = useState(false);

  const fetchAll = useCallback(async () => {
    const [connectionsRes, zonesRes] = await Promise.all([fetch("/api/agent-connections"), fetch("/api/agent-connections/zones")]);
    if (connectionsRes.ok) setConnections((await connectionsRes.json()).connections ?? []);
    if (zonesRes.ok) setZones((await zonesRes.json()).zones ?? []);
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  async function handleRegister() {
    setError(null);
    if (!newId || !newLabel) {
      setError("Id and label are required");
      return;
    }
    setRegistering(true);
    try {
      const res = await fetch("/api/agent-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: newId, label: newLabel }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to register connection");
        return;
      }
      setNewId("");
      setNewLabel("");
      await fetchAll();
    } finally {
      setRegistering(false);
    }
  }

  async function handleToggleEnabled(connection: AgentConnection) {
    await fetch(`/api/agent-connections/${encodeURIComponent(connection.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !connection.enabled }),
    });
    await fetchAll();
  }

  async function handleAssignZone(capabilityId: string, assignedConnectionId: string | null) {
    await fetch("/api/agent-connections/zones", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilityId, assignedConnectionId }),
    });
    await fetchAll();
  }

  const zoneByCapabilityId = new Map(zones.map((z) => [z.capabilityId, z.assignedConnectionId]));
  const domains = [...new Set(ZONEABLE_CAPABILITIES.map((c) => c.domain))];

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Agent connections &amp; responsibility zones
          <InfoTooltip>
            Lets more than one agent client (e.g. Claude and Codex) connect at once, each
            exclusively responsible for its own set of actions, while all connected agents still
            see the same underlying data. Each client sets its own AGENT_CONNECTION_ID (env
            variable) in its own MCP launch config, or --agentConnectionId for the CLI, matching a
            connection id registered here. While no connection is registered below, this has zero
            effect -- identical to today&rsquo;s single-agent behavior. Once one or more are
            registered, every zoned action requires a resolvable, registered, enabled connection
            id -- an unrecognized one is rejected, never silently allowed.
          </InfoTooltip>
        </h3>
      </div>

      <div className="rounded-lg border border-zinc-800 p-4">
        <h4 className="mb-3 text-sm font-semibold text-zinc-200">Register a new connection</h4>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-zinc-400">Id (lowercase, digits, hyphen/underscore -- e.g. &quot;claude&quot;)</span>
            <input
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400">Label</span>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            />
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <button
          onClick={handleRegister}
          disabled={registering}
          className="mt-3 rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {registering ? "Registering..." : "Register connection"}
        </button>
      </div>

      <div className="space-y-2">
        {connections.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-800 p-3">
            <div>
              <p className="text-sm font-medium text-zinc-200">
                {c.label} <span className="text-xs text-zinc-500">({c.id})</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ToggleSwitch label={`Enable ${c.label}`} checked={c.enabled} onChange={() => handleToggleEnabled(c)} />
              <span className="text-xs text-zinc-400">{c.enabled ? "Enabled" : "Disabled"}</span>
            </div>
          </div>
        ))}
        {connections.length === 0 && <p className="text-sm text-zinc-500">No agent connections registered yet -- zoning has no effect.</p>}
      </div>

      {connections.length > 0 && (
        <div className="space-y-4 border-t border-zinc-800 pt-4">
          <h4 className="text-sm font-semibold text-zinc-200">Responsibility zones</h4>
          {domains.map((domain) => (
            <div key={domain} className="space-y-2">
              <p className="text-xs font-medium uppercase text-zinc-500">{domain}</p>
              {ZONEABLE_CAPABILITIES.filter((c) => c.domain === domain).map((c) => {
                const assignedConnectionId = zoneByCapabilityId.get(c.capabilityId) ?? null;
                return (
                  <div key={c.capabilityId} className="flex items-center justify-between rounded-lg border border-zinc-800 p-3">
                    <span className="text-sm text-zinc-300">{c.label}</span>
                    <select
                      value={assignedConnectionId ?? ""}
                      onChange={(e) => handleAssignZone(c.capabilityId, e.target.value || null)}
                      className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
                    >
                      <option value="">Any registered, enabled connection</option>
                      {connections.map((conn) => (
                        <option key={conn.id} value={conn.id}>
                          {conn.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
