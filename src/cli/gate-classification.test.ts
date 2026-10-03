import assert from "node:assert/strict";
import test from "node:test";
import { CLI_COMMANDS_BY_NAMESPACE, CLI_METADATA_COMMANDS, classifyCliCommand } from "./video-metadata";

// BL-009: the device-availability gate keys on the fully qualified `namespace command`. The expectation below is written by hand from
// docs/DEVELOPMENT_PLAYBOOK.md §6.7's three-way classification (a command that persists anything is gated), not read back from the sets.

const HAND_WRITTEN_GATED = [
  "metadata apply",
  "auth select-channel",
  "auth select-user",
  "playlist create",
  "playlist update",
  "playlist delete",
  "playlist add",
  "playlist remove",
  "changeset import",
  "channel sync",
  "ai-localization create-change-set",
  "agent create-content-proposal",
  "agent register-external-artifact",
  "agent create-research-request",
  "agent create-experiment-proposal",
  "asset register",
].sort();

function everyCommand(): Array<{ namespace: string; command: string }> {
  return [
    ...CLI_METADATA_COMMANDS.map((command) => ({ namespace: "metadata", command })),
    ...Object.entries(CLI_COMMANDS_BY_NAMESPACE).flatMap(([namespace, commands]) => commands.map((command) => ({ namespace, command }))),
  ];
}

test("exactly the commands that persist something are gated; login/logout/revoke are the only session-exempt ones", () => {
  const all = everyCommand();
  const gated = all.filter((c) => classifyCliCommand(c.namespace, c.command) === "gated").map((c) => `${c.namespace} ${c.command}`).sort();
  assert.deepEqual(gated, HAND_WRITTEN_GATED);
  const exempt = all.filter((c) => classifyCliCommand(c.namespace, c.command) === "auth_session_exempt").map((c) => `${c.namespace} ${c.command}`).sort();
  assert.deepEqual(exempt, ["auth login", "auth logout", "auth revoke"]);
});

test("every other command is read-only: hand count 3+3+1+3+2+2+6+1+21 = 42 read-only, plus 16 gated and 3 exempt", () => {
  const all = everyCommand();
  const readOnly = all.filter((c) => classifyCliCommand(c.namespace, c.command) === "read_only");
  assert.equal(readOnly.length, 42);
  assert.equal(all.length, 42 + HAND_WRITTEN_GATED.length + 3);
});

test("a bare command word is never enough: the same word is read-only in one namespace and gated in another or an unknown one", () => {
  assert.equal(classifyCliCommand("playlist", "list"), "read_only");
  assert.equal(classifyCliCommand("batch", "list"), "read_only");
  // a hypothetical future namespace reusing `list` / `get` / `preview` / `generate` / `login` must NOT inherit another namespace's classification
  for (const word of ["list", "get", "preview", "generate", "whoami", "login", "overview"]) {
    assert.equal(classifyCliCommand("future-namespace", word), "gated", `future-namespace ${word}`);
  }
  // and a known namespace with a command it does not define is gated too
  assert.equal(classifyCliCommand("asset", "list"), "gated");
  assert.equal(classifyCliCommand("agent", "login"), "gated");
});
