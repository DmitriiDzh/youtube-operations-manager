import assert from "node:assert/strict";
import test from "node:test";
import { SCHEMA_CURRENT_VERSION } from "@/lib/db";
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
