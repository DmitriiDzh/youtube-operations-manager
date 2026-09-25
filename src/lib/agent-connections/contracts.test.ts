import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentConnectionIdFromEnv } from "./contracts";

// Both callers (MCP's env-var parsing at startMcpServer, CLI's fallback after
// --agentConnectionId) share this single implementation, so testing it here covers both
// transports regardless of which one invokes it.

test("resolveAgentConnectionIdFromEnv returns the trimmed value for a real non-empty string", () => {
  assert.equal(resolveAgentConnectionIdFromEnv("claude"), "claude");
  assert.equal(resolveAgentConnectionIdFromEnv("  claude  "), "claude");
});

test("resolveAgentConnectionIdFromEnv returns null for undefined", () => {
  assert.equal(resolveAgentConnectionIdFromEnv(undefined), null);
});

test("resolveAgentConnectionIdFromEnv returns null for an empty string (never a literal empty-string identity)", () => {
  assert.equal(resolveAgentConnectionIdFromEnv(""), null);
});

test("resolveAgentConnectionIdFromEnv returns null for a whitespace-only string", () => {
  assert.equal(resolveAgentConnectionIdFromEnv("   "), null);
});
