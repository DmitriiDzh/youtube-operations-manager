import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "./index";

// Phase 14 slice 6 (found live 2026-10-05): the media core is cached on globalThis and built first by the instrumentation
// bundle, so a route sees a DomainError from ANOTHER copy of this class -- `instanceof` alone turned a 409 into a 500.
test("isDomainError recognizes a DomainError from another bundle's copy of the class, and nothing else", () => {
  class ForeignDomainError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "DomainError";
      this.code = code;
    }
  }
  assert.equal(isDomainError(new DomainError({ code: "media_session_conflict", message: "x" })), true);
  assert.equal(isDomainError(new ForeignDomainError("media_session_conflict", "x")), true);
  assert.equal(isDomainError(new Error("plain")), false);
  const named = new Error("no code");
  named.name = "DomainError";
  assert.equal(isDomainError(named), false);
  assert.equal(isDomainError({ name: "DomainError", code: "x", message: "not an Error" }), false);
});
