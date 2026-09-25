import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createAgentConnectionsServices, type ServiceDependencies } from "./services";

type FakeConnectionRow = { id: string; label: string; enabled: boolean; createdAt: Date };
type FakeZoneRow = { capabilityId: string; assignedConnectionId: string | null };

function createFakeDeps(): ServiceDependencies & {
  connections: Map<string, FakeConnectionRow>;
  zones: Map<string, FakeZoneRow>;
} {
  const connections = new Map<string, FakeConnectionRow>();
  const zones = new Map<string, FakeZoneRow>();

  return {
    connections,
    zones,
    async insertConnection(input) {
      connections.set(input.id, { ...input, createdAt: new Date() });
    },
    async listConnections() {
      return [...connections.values()];
    },
    async getConnectionById(id) {
      return connections.get(id) ?? null;
    },
    async updateConnectionEnabled(id, enabled) {
      const existing = connections.get(id);
      if (existing) connections.set(id, { ...existing, enabled });
    },
    async upsertZone(input) {
      zones.set(input.capabilityId, { ...input });
    },
    async listZones() {
      return [...zones.values()];
    },
    async getZoneByCapabilityId(capabilityId) {
      return zones.get(capabilityId) ?? null;
    },
  };
}

test("registerConnection creates a connection with the given id/label, defaulting enabled to true", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  const created = await services.registerConnection({ id: "claude", label: "Claude" });

  assert.equal(created.id, "claude");
  assert.equal(created.label, "Claude");
  assert.equal(created.enabled, true);
  assert.equal(typeof created.createdAt, "string");
});

test("registerConnection rejects a duplicate id with AGENT_CONNECTION_ID_CONFLICT", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "codex", label: "Codex" });

  await assert.rejects(
    () => services.registerConnection({ id: "codex", label: "Codex again" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_CONNECTION_ID_CONFLICT"
  );
});

test("registerConnection rejects an id with disallowed characters", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  await assert.rejects(
    () => services.registerConnection({ id: "Claude Desktop!", label: "Claude" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("listConnections returns every registered connection", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });

  const listed = await services.listConnections();

  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((c) => c.id).sort(),
    ["claude", "codex"]
  );
});

test("setConnectionEnabled flips enabled and returns the updated row", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });

  const updated = await services.setConnectionEnabled({ id: "claude", enabled: false });

  assert.equal(updated.enabled, false);
});

test("setConnectionEnabled rejects an unknown id with AGENT_CONNECTION_NOT_AVAILABLE", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  await assert.rejects(
    () => services.setConnectionEnabled({ id: "unknown", enabled: true }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_CONNECTION_NOT_AVAILABLE"
  );
});

test("assignCapabilityZone assigns a capability to an existing connection", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "codex", label: "Codex" });

  const zone = await services.assignCapabilityZone({
    capabilityId: "content_proposal.register_external_artifact",
    assignedConnectionId: "codex",
  });

  assert.deepEqual(zone, {
    capabilityId: "content_proposal.register_external_artifact",
    assignedConnectionId: "codex",
  });
});

test("assignCapabilityZone rejects an assignedConnectionId that does not exist", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  await assert.rejects(
    () =>
      services.assignCapabilityZone({
        capabilityId: "content_proposal.register_external_artifact",
        assignedConnectionId: "does-not-exist",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_CONNECTION_NOT_AVAILABLE"
  );
});

test("assignCapabilityZone accepts assignedConnectionId: null (unassigning) without requiring a connection to exist", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  const zone = await services.assignCapabilityZone({
    capabilityId: "content_proposal.create_content_proposal",
    assignedConnectionId: null,
  });

  assert.deepEqual(zone, { capabilityId: "content_proposal.create_content_proposal", assignedConnectionId: null });
});

test("assignCapabilityZone re-assigning the same capability id overwrites the previous assignment (upsert, not append)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });
  await services.assignCapabilityZone({ capabilityId: "content_proposal.create_content_proposal", assignedConnectionId: "claude" });

  await services.assignCapabilityZone({ capabilityId: "content_proposal.create_content_proposal", assignedConnectionId: "codex" });

  const zones = await services.listCapabilityZones();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].assignedConnectionId, "codex");
});

test("assertAgentAllowedForCapability is a no-op when zero connections are registered (identical to today's single-agent behavior)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);

  await assert.doesNotReject(() =>
    services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: null })
  );
});

test("assertAgentAllowedForCapability is a no-op again once every registered connection has been disabled (the escape hatch back to single-agent behavior)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.setConnectionEnabled({ id: "claude", enabled: false });

  await assert.doesNotReject(() =>
    services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: null })
  );
});

test("assertAgentAllowedForCapability rejects a missing caller identity once at least one connection is enabled (fail-closed)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });

  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: null }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("assertAgentAllowedForCapability rejects an unknown callerConnectionId once at least one connection is enabled", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });

  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: "codex" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("assertAgentAllowedForCapability rejects a disabled connection even when it supplies its own id", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.setConnectionEnabled({ id: "claude", enabled: false });
  // Register a second, enabled connection so the fail-closed gate is active for this assertion
  // (a lone disabled connection alone would hit the no-op path above, not this rejection).
  await services.registerConnection({ id: "codex", label: "Codex" });

  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: "claude" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("assertAgentAllowedForCapability allows the sole enabled connection when the capability has no zone assigned (unambiguous with only one possible caller)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "codex", label: "Codex" });

  await assert.doesNotReject(() =>
    services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: "codex" })
  );
});

test("assertAgentAllowedForCapability rejects EVERY caller for an unassigned capability once 2+ connections are enabled (owner's exclusivity rule: an unassigned zone must never be shared)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });

  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: "claude" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.create_content_proposal", callerConnectionId: "codex" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("assertAgentAllowedForCapability allows an explicitly assigned capability even with 2+ connections enabled, and still rejects every other one", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });
  await services.assignCapabilityZone({ capabilityId: "content_proposal.register_external_artifact", assignedConnectionId: "codex" });

  await assert.doesNotReject(() =>
    services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.register_external_artifact", callerConnectionId: "codex" })
  );
  await assert.rejects(
    () =>
      services.assertAgentAllowedForCapability({ capabilityId: "content_proposal.register_external_artifact", callerConnectionId: "claude" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("assertAgentAllowedForCapability: a third, unassigned capability stays rejected for both while a second one is explicitly assigned (assignments are independent per capability)", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });
  await services.assignCapabilityZone({ capabilityId: "content_proposal.register_external_artifact", assignedConnectionId: "codex" });

  await assert.rejects(
    () => services.assertAgentAllowedForCapability({ capabilityId: "channel_sync", callerConnectionId: "claude" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_ZONE_VIOLATION"
  );
});

test("listCapabilityZones returns every assigned zone", async () => {
  const deps = createFakeDeps();
  const services = createAgentConnectionsServices(deps);
  await services.registerConnection({ id: "claude", label: "Claude" });
  await services.registerConnection({ id: "codex", label: "Codex" });
  await services.assignCapabilityZone({ capabilityId: "content_proposal.create_content_proposal", assignedConnectionId: "claude" });
  await services.assignCapabilityZone({ capabilityId: "content_proposal.register_external_artifact", assignedConnectionId: "codex" });

  const zones = await services.listCapabilityZones();

  assert.equal(zones.length, 2);
});
