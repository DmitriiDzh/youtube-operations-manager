import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { resolveLocalizationProvider } from "./provider-registry";

// AC-PROVIDER-01
test("AC-PROVIDER-01: resolveLocalizationProvider('mock') returns a working provider", async () => {
  const provider = resolveLocalizationProvider("mock");
  assert.equal(provider.name, "mock");
  const outcome = await provider.generate({
    videoId: "v1",
    targetLanguage: "es",
    sourceLanguage: "en",
    sourceTitle: "Hello",
    sourceDescription: "World",
  });
  assert.equal(outcome.status, "ok");
});

test("AC-PROVIDER-01: any non-mock provider name fails closed with provider_not_configured, no fallback", () => {
  assert.throws(
    () => resolveLocalizationProvider("openai"),
    (err: unknown) => {
      assert.ok(err instanceof DomainError);
      assert.equal(err.code, "provider_not_configured");
      assert.deepEqual((err.details as { requestedProvider: string }).requestedProvider, "openai");
      return true;
    }
  );
});

test("AC-PROVIDER-01: an empty/unknown provider name also fails closed", () => {
  assert.throws(
    () => resolveLocalizationProvider("anthropic"),
    (err: unknown) => err instanceof DomainError && err.code === "provider_not_configured"
  );
});
