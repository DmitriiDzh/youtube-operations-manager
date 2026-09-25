import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DomainError } from "./contracts";
import { createAgentConnectionsCore } from "./index";

// Wiring test -- uses the REAL store adapter/db, unlike services.test.ts's injected fakes.
test("createAgentConnectionsCore round-trips a real register/list/enable/assign against the real database", async () => {
  const core = createAgentConnectionsCore();
  const id = `test-${randomUUID().slice(0, 8)}`;

  const created = await core.registerConnection({ id, label: "Test agent" });
  assert.equal(created.id, id);
  assert.equal(created.enabled, true);

  const listed = await core.listConnections();
  assert.ok(listed.some((c) => c.id === id));

  const disabled = await core.setConnectionEnabled({ id, enabled: false });
  assert.equal(disabled.enabled, false);

  const capabilityId = `test.capability.${randomUUID().slice(0, 8)}`;
  const zone = await core.assignCapabilityZone({ capabilityId, assignedConnectionId: id });
  assert.equal(zone.assignedConnectionId, id);

  const zones = await core.listCapabilityZones();
  assert.ok(zones.some((z) => z.capabilityId === capabilityId && z.assignedConnectionId === id));
});

test("createAgentConnectionsCore.registerConnection rejects a real duplicate id round-trip", async () => {
  const core = createAgentConnectionsCore();
  const id = `test-${randomUUID().slice(0, 8)}`;
  await core.registerConnection({ id, label: "First" });

  await assert.rejects(
    () => core.registerConnection({ id, label: "Second" }),
    (error: unknown) => error instanceof DomainError && error.code === "AGENT_CONNECTION_ID_CONFLICT"
  );
});
