import assert from "node:assert/strict";
import test from "node:test";
import { CREATED_VIA_VALUES, createdViaSchema, evidenceReferenceSchema, evidenceSourceTypeSchema } from "./index";

test("createdViaSchema accepts exactly the three known transports and rejects anything else", () => {
  for (const value of CREATED_VIA_VALUES) {
    assert.equal(createdViaSchema.parse(value), value);
  }
  assert.throws(() => createdViaSchema.parse("web_browser"));
});

test("evidenceSourceTypeSchema accepts the known source types and rejects an unknown one", () => {
  assert.equal(evidenceSourceTypeSchema.parse("external_research"), "external_research");
  assert.throws(() => evidenceSourceTypeSchema.parse("made_up"));
});

test("evidenceReferenceSchema requires the core fields, treats excerpt as optional, and rejects unknown keys", () => {
  const parsed = evidenceReferenceSchema.parse({
    url: "https://example.com/report",
    retrievedAt: "2026-09-24T00:00:00.000Z",
    description: "Comparable-video title-length analysis",
    claimSupported: "Shorter titles perform better",
    sourceType: "external_research",
  });
  assert.equal(parsed.excerpt, undefined);

  assert.throws(() =>
    evidenceReferenceSchema.parse({
      url: "https://example.com/report",
      retrievedAt: "2026-09-24T00:00:00.000Z",
      description: "d",
      claimSupported: "c",
      sourceType: "external_research",
      unexpectedField: "nope",
    })
  );

  assert.throws(() =>
    evidenceReferenceSchema.parse({
      retrievedAt: "2026-09-24T00:00:00.000Z",
      description: "d",
      claimSupported: "c",
      sourceType: "external_research",
    })
  );
});
