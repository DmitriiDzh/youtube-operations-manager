import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SCHEMA_CURRENT_VERSION, upsertChannel } from "@/lib/db";
import { DomainError } from "./contracts";
import { createAgentOperationsCore } from "./index";

// Wiring test -- uses the REAL dependencies (real package.json, real SCHEMA_CURRENT_VERSION),
// unlike services.test.ts's injected fakes. Only asserts what's independently verifiable without
// re-deriving the implementation's own output: schemaVersions.app must equal the real, separately
// imported SCHEMA_CURRENT_VERSION constant (not a copy of what the code under test computed), and
// productVersion must be a real, non-empty string (never the "unknown" fallback, since this repo's
// own package.json always has a version field).
test("createAgentOperationsCore wires real productVersion/schemaVersion, matching independently-checkable values", async () => {
  const core = createAgentOperationsCore();
  const result = await core.getSystemCapabilities({});

  assert.equal(result.schemaVersions.app, SCHEMA_CURRENT_VERSION);
  assert.equal(typeof result.productVersion, "string");
  assert.notEqual(result.productVersion, "unknown");
  assert.ok(result.productVersion.length > 0);
});

// Slice C credential-threading wiring test: unlike
// services.test.ts's fully-stubbed `getChannelOverview`/`listMetrics`, this exercises the REAL
// `analyticsCore` wired in by `createAgentOperationsCore()`. This module's own service function
// does zero credential/channel checking of its own -- it only forwards `credentialRef` straight
// to `analyticsCore.listMetrics`/`getChannelOverview`, which do that check internally. If the
// wiring silently dropped or mis-threaded the input (e.g. never actually reaching the real
// analytics service), this would either throw a generic validation error or -- worse -- silently
// succeed with no data; a real, resolvable-looking `credentialRef` paired with a channel that was
// never activated for that user forces the REAL `assertActiveChannel` path inside `analyticsCore`
// to run and fail closed, proving the wrapper genuinely reaches the real service rather than a
// mock (and that a required, already-resolved `credentialRef` is what this module's own schema
// actually expects).
test("createAgentOperationsCore.queryVideoAnalytics reaches the REAL analyticsCore (fails closed on a never-activated channel, not a mock)", async () => {
  const core = createAgentOperationsCore();

  await assert.rejects(
    () =>
      core.queryVideoAnalytics({
        credentialRef: { userId: "agent-ops-wiring-test-user" },
        channelId: "UC_AGENT_OPS_WIRING_TEST_NEVER_ACTIVATED",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("createAgentOperationsCore.queryChannelAnalytics reaches the REAL analyticsCore (fails closed on a never-activated channel, not a mock)", async () => {
  const core = createAgentOperationsCore();

  await assert.rejects(
    () =>
      core.queryChannelAnalytics({
        credentialRef: { userId: "agent-ops-wiring-test-user" },
        channelId: "UC_AGENT_OPS_WIRING_TEST_NEVER_ACTIVATED",
        startDate: "2026-09-01",
        endDate: "2026-09-07",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

// Slice E wiring test: uses the REAL aiLocalizationCore, unlike services.test.ts's stub. This
// module's own getGenerationProvenance does zero channel-scoping of its own -- it forwards
// straight to aiLocalizationCore.getGenerationProvenance, which does its own real check
// internally. A real, freshly-synced channel with no Change Sets at all must return null (not
// throw, not fabricate a record), proving the wrapper reaches the real service.
test("createAgentOperationsCore.getGenerationProvenance reaches the REAL aiLocalizationCore (returns null for a real channel with no recorded provenance, not a mock)", async () => {
  const core = createAgentOperationsCore();
  const channelId = `UC_TEST_${randomUUID()}`;

  await upsertChannel({
    channelId,
    title: "Agent-operations provenance wiring test channel",
    thumbnailUrl: null,
    uploadsPlaylistId: `UU_${randomUUID()}`,
    connectedUserId: null,
  });

  const result = await core.getGenerationProvenance({ channelId, changeSetId: "cs-does-not-exist" });
  assert.equal(result, null);
});
