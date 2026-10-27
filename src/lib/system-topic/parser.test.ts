import assert from "node:assert/strict";
import test from "node:test";
import { parseSystemCommand } from "./parser";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2, ADR 0053 Amendment 1, FO-RESP-0043 H4): the grammar `help`, `approve <id>`, `deny <id>`;
// `status` / `stop` / `go` are the hub's (answered "handled by the hub"); the command word case-insensitive, with an optional `/`
// and `@botname`; anything else is `unknown`, and a command with the wrong arguments is `usage`.

test("each command with its arguments", () => {
  assert.deepEqual(parseSystemCommand("help"), { kind: "help" });
  assert.deepEqual(parseSystemCommand("approve r-42"), { kind: "approve", id: "r-42" });
  assert.deepEqual(parseSystemCommand("deny 2026-10-27_media.1"), { kind: "deny", id: "2026-10-27_media.1" });
});

test("status, stop and go -- with or without arguments -- belong to the hub", () => {
  assert.deepEqual(parseSystemCommand("status"), { kind: "hub", word: "status" });
  assert.deepEqual(parseSystemCommand("stop tropico plan"), { kind: "hub", word: "stop" });
  assert.deepEqual(parseSystemCommand("/Go@HubBot japan"), { kind: "hub", word: "go" });
});

test("the command word in any case, with / and @botname, and extra whitespace", () => {
  assert.deepEqual(parseSystemCommand("  APPROVE   r1 \n"), { kind: "approve", id: "r1" });
  assert.deepEqual(parseSystemCommand("/approve@HubSystemBot r1"), { kind: "approve", id: "r1" });
  assert.deepEqual(parseSystemCommand("/Help"), { kind: "help" });
});

test("the wrong arguments are usage, not a guess; an id never carries a path", () => {
  assert.deepEqual(parseSystemCommand("help me"), { kind: "usage", command: "help" });
  assert.deepEqual(parseSystemCommand("approve"), { kind: "usage", command: "approve" });
  assert.deepEqual(parseSystemCommand("approve a b"), { kind: "usage", command: "approve" });
  assert.deepEqual(parseSystemCommand("approve ../x"), { kind: "usage", command: "approve" });
  assert.deepEqual(parseSystemCommand("approve .hidden"), { kind: "usage", command: "approve" });
  assert.deepEqual(parseSystemCommand("deny $(rm -rf /)"), { kind: "usage", command: "deny" });
});

test("anything else is unknown -- no text is ever executed", () => {
  for (const text of ["", "   ", "rm -rf /", "approved r1", "please approve r1", "/start", "approve;ls", "@bot approve r1", "одобрить r1"]) {
    assert.deepEqual(parseSystemCommand(text), { kind: "unknown" }, JSON.stringify(text));
  }
});
