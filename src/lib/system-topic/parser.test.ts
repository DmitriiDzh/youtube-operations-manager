import assert from "node:assert/strict";
import test from "node:test";
import { parseSystemCommand } from "./parser";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2, ADR 0053 §3): the fixed grammar `help`, `status [<channel>]`, `stop <channel> <jobId|plan>`,
// `go <channel>`, `approve <id>`, `deny <id>`; the command word case-insensitive, with an optional `/` and `@botname`; anything else
// is `unknown`, and one of the six words with the wrong arguments is `usage`.

test("each command with its arguments", () => {
  assert.deepEqual(parseSystemCommand("help"), { kind: "help" });
  assert.deepEqual(parseSystemCommand("status"), { kind: "status", channel: null });
  assert.deepEqual(parseSystemCommand("status tropico"), { kind: "status", channel: "tropico" });
  assert.deepEqual(parseSystemCommand("stop tropico job-20261027-1"), { kind: "stop", channel: "tropico", target: "job-20261027-1" });
  assert.deepEqual(parseSystemCommand("stop tropico plan"), { kind: "stop", channel: "tropico", target: "plan" });
  assert.deepEqual(parseSystemCommand("go japan"), { kind: "go", channel: "japan" });
  assert.deepEqual(parseSystemCommand("approve r-42"), { kind: "approve", id: "r-42" });
  assert.deepEqual(parseSystemCommand("deny r-42"), { kind: "deny", id: "r-42" });
});

test("the command word in any case, with / and @botname, and extra whitespace", () => {
  assert.deepEqual(parseSystemCommand("  STATUS   tropico \n"), { kind: "status", channel: "tropico" });
  assert.deepEqual(parseSystemCommand("/status@HubSystemBot tropico"), { kind: "status", channel: "tropico" });
  assert.deepEqual(parseSystemCommand("/Help"), { kind: "help" });
  assert.deepEqual(parseSystemCommand("Go\ttropico"), { kind: "go", channel: "tropico" });
});

test("the wrong arguments are usage, not a guess", () => {
  assert.deepEqual(parseSystemCommand("help me"), { kind: "usage", command: "help" });
  assert.deepEqual(parseSystemCommand("status tropico japan"), { kind: "usage", command: "status" });
  assert.deepEqual(parseSystemCommand("status ../x"), { kind: "usage", command: "status" });
  assert.deepEqual(parseSystemCommand("stop tropico"), { kind: "usage", command: "stop" });
  assert.deepEqual(parseSystemCommand("go"), { kind: "usage", command: "go" });
  assert.deepEqual(parseSystemCommand("approve"), { kind: "usage", command: "approve" });
  assert.deepEqual(parseSystemCommand("deny a b"), { kind: "usage", command: "deny" });
  assert.deepEqual(parseSystemCommand("approve $(rm -rf /)"), { kind: "usage", command: "approve" });
});

test("anything else is unknown -- no text is ever executed", () => {
  for (const text of ["", "   ", "rm -rf /", "statuses", "please stop tropico", "/start", "status;ls", "@bot status", "статус"]) {
    assert.deepEqual(parseSystemCommand(text), { kind: "unknown" }, JSON.stringify(text));
  }
});
