import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createAgentOperationsServices } from "./services";

function createFixture(overrides: Partial<{ productVersion: string; schemaVersion: number }> = {}) {
  const services = createAgentOperationsServices({
    getProductVersion: () => overrides.productVersion ?? "9.9.9",
    getSchemaVersion: () => overrides.schemaVersion ?? 14,
  });
  return { services };
}

// AC-CAP-01: every field the owner spec §4 asked `get_system_capabilities()` to report is
// actually present, using injected (not real) dependencies so this test doesn't depend on the
// real package.json version or the real current schema version.
test("getSystemCapabilities returns every field the spec requires, sourced from injected dependencies", async () => {
  const { services } = createFixture({ productVersion: "9.9.9", schemaVersion: 14 });
  const result = await services.getSystemCapabilities({});

  assert.equal(result.productVersion, "9.9.9");
  assert.equal(result.agentApiVersion, "0.1.0");
  assert.equal(result.schemaVersions.app, 14);
  assert.ok(Array.isArray(result.capabilities));
  assert.ok(Array.isArray(result.dataDomains));
  assert.ok(Array.isArray(result.actionClasses));
  assert.ok(Array.isArray(result.grantedPermissions));
  assert.ok(Array.isArray(result.plannedFutureCapabilities));
});

// AC-CAP-02: the single most safety-critical assertion in this slice -- Codex (or any agent)
// must never be told it holds APPROVE/EXECUTE, since granting either implicitly would violate
// the owner's own explicit "AI may propose, human approves" invariant (AGENTS.md §G).
test("grantedPermissions is exactly READ+DRAFT -- never APPROVE or EXECUTE", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(result.grantedPermissions, ["READ", "DRAFT"]);
  assert.ok(!result.grantedPermissions.includes("APPROVE" as never));
  assert.ok(!result.grantedPermissions.includes("EXECUTE" as never));
});

// AC-CAP-03: actionClasses is the full 4-class vocabulary the permission MODEL recognizes,
// deliberately a superset of what's actually granted -- an agent must be able to tell "this
// system has an APPROVE concept, I just don't hold it" from "this system has no such concept."
test("actionClasses lists all four permission classes, distinct from the narrower grantedPermissions", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(result.actionClasses, ["READ", "DRAFT", "APPROVE", "EXECUTE"]);
  assert.ok(result.actionClasses.length > result.grantedPermissions.length);
});

// AC-CAP-04: this capability must describe itself -- an agent calling get_capabilities should
// see the very tool it just called listed as an available READ capability.
test("capabilities includes system.get_capabilities itself, classified READ", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  const self = result.capabilities.find((c) => c.id === "system.get_capabilities");
  assert.ok(self, "system.get_capabilities must list itself");
  assert.equal(self!.permission, "READ");
  assert.equal(self!.domain, "system");
});

// AC-CAP-05: exactly the three future capabilities the owner's own spec §14 named as extension
// points -- not more (scope creep into implying an unbuilt capability exists) and not fewer.
test("plannedFutureCapabilities is exactly the three extension points from the owner's spec §14, no more no less", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});

  assert.deepEqual(
    [...result.plannedFutureCapabilities].sort(),
    ["create_experiment_proposal", "query_competitors", "query_market_intelligence"].sort()
  );
});

// AC-CAP-08: the input schema is a strict empty object -- an unexpected extra field must fail
// loudly (validation_failed), never be silently ignored.
test("rejects an unexpected input field as validation_failed", async () => {
  const { services } = createFixture();

  await assert.rejects(
    () => services.getSystemCapabilities({ unexpectedField: "oops" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("accepts a genuinely empty input object", async () => {
  const { services } = createFixture();
  const result = await services.getSystemCapabilities({});
  assert.ok(result.agentApiVersion);
});
