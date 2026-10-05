import assert from "node:assert/strict";
import test from "node:test";
import type { MediaGenerationCore } from "@/lib/media-generation";
import { classifyMediaCommand, MEDIA_CLI_COMMANDS, parseMediaArgs, runMediaCli } from "./media";

// AC-P14-20 (docs/roadmap/plans/PHASE_14_PLAN.md): JSON envelope, non-zero on failure, no secret
// in any argument; "Operator CLI access" off -> refused; mutating commands pass the device gate.

function fakeCore(overrides: Partial<Record<keyof MediaGenerationCore, unknown>> = {}) {
  const calls: string[] = [];
  const core = {
    getOverview: async () => {
      calls.push("getOverview");
      return { credentials: { configured: false, reason: "no_credentials" }, ready: false };
    },
    listPods: async () => {
      calls.push("listPods");
      return [];
    },
    terminatePod: async (id: string) => {
      calls.push(`terminatePod:${id}`);
      return { terminated: true, alreadyGone: false };
    },
    createNetworkVolume: async (input: unknown) => {
      calls.push(`createNetworkVolume:${JSON.stringify(input)}`);
      return { id: "vol-new" };
    },
    createPod: async (input: unknown) => {
      calls.push(`createPod:${JSON.stringify(input)}`);
      return { id: "pod1" };
    },
    ...overrides,
  } as unknown as MediaGenerationCore;
  return { core, calls };
}

function capture() {
  const lines: string[] = [];
  return { lines, writeStdout: (line: string) => lines.push(line) };
}

test("parseMediaArgs: flags, positionals, unknown command and --help", () => {
  assert.deepEqual(parseMediaArgs(["volume-create", "--name", "models", "--dc", "EU-RO-1", "--size", "150"]), {
    command: "volume-create",
    positional: [],
    flags: { name: "models", dc: "EU-RO-1", size: "150" },
  });
  assert.deepEqual(parseMediaArgs(["s3-get", "exchange/a.png", "/tmp/a.png"]).positional, ["exchange/a.png", "/tmp/a.png"]);
  assert.throws(() => parseMediaArgs(["nope"]));
  assert.throws(() => parseMediaArgs([]));
});

test("exactly the commands that create, delete or upload something are gated", () => {
  const gated = MEDIA_CLI_COMMANDS.filter((c) => classifyMediaCommand(c) === "gated");
  // `credentials-test` is gated too since review round 13: it writes `verified_at` to the local database.
  assert.deepEqual(gated, ["credentials-test", "volume-create", "template-create", "workflow-template-import", "job-create", "janitor", "model-pull", "model-rm", "pod-create", "pod-terminate", "s3-put", "s3-rm"]);
});

test("Operator CLI access off -> refused with AGENT_TOKEN_INVALID, exit 1, core untouched", async () => {
  const { core, calls } = fakeCore();
  const out = capture();
  const code = await runMediaCli({ argv: ["status"], core, operatorCliEnabled: async () => false, writeStdout: out.writeStdout });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out.lines[0]).error.code, "AGENT_TOKEN_INVALID");
  assert.deepEqual(calls, []);
});

test("a read-only command prints {ok:true,data} and skips the device gate; a gated one calls it first", async () => {
  const { core, calls } = fakeCore();
  const gate: string[] = [];
  const out = capture();
  const assertDeviceAvailable = async () => {
    gate.push("gate");
  };
  assert.equal(await runMediaCli({ argv: ["pods"], core, operatorCliEnabled: async () => true, assertDeviceAvailable, writeStdout: out.writeStdout }), 0);
  assert.deepEqual(JSON.parse(out.lines[0]), { ok: true, data: [] });
  assert.deepEqual(gate, []);
  assert.equal(await runMediaCli({ argv: ["pod-terminate", "p1"], core, operatorCliEnabled: async () => true, assertDeviceAvailable, writeStdout: out.writeStdout }), 0);
  assert.deepEqual(gate, ["gate"]);
  assert.deepEqual(calls, ["listPods", "terminatePod:p1"]);
});

test("a blocked device gate stops a mutating command before the core runs", async () => {
  const { core, calls } = fakeCore();
  const out = capture();
  const code = await runMediaCli({
    argv: ["volume-create", "--name", "m", "--dc", "EU-RO-1", "--size", "150"],
    core,
    operatorCliEnabled: async () => true,
    assertDeviceAvailable: async () => {
      throw new Error("operation lock held");
    },
    writeStdout: out.writeStdout,
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out.lines[0]).ok, false);
  assert.deepEqual(calls, []);
});

test("pod-create reads the body from --file and rejects malformed JSON", async () => {
  const { core, calls } = fakeCore();
  const out = capture();
  const ok = await runMediaCli({
    argv: ["pod-create", "--file", "body.json"],
    core,
    operatorCliEnabled: async () => true,
    assertDeviceAvailable: async () => {},
    readFileText: async () => JSON.stringify({ name: "media", templateId: "t" }),
    writeStdout: out.writeStdout,
  });
  assert.equal(ok, 0);
  assert.deepEqual(calls, ['createPod:{"name":"media","templateId":"t"}']);
  const bad = await runMediaCli({
    argv: ["pod-create", "--file", "body.json"],
    core,
    operatorCliEnabled: async () => true,
    assertDeviceAvailable: async () => {},
    readFileText: async () => "{",
    writeStdout: out.writeStdout,
  });
  assert.equal(bad, 1);
  assert.equal(JSON.parse(out.lines[1]).error.code, "validation_failed");
});

test("a DomainError from the core becomes the JSON error envelope with its code", async () => {
  const { DomainError } = await import("@/lib/media-generation");
  const { core } = fakeCore({
    getOverview: async () => {
      throw new DomainError({ code: "media_generation_not_configured", message: "nope" });
    },
  });
  const out = capture();
  assert.equal(await runMediaCli({ argv: ["status"], core, operatorCliEnabled: async () => true, writeStdout: out.writeStdout }), 1);
  assert.equal(JSON.parse(out.lines[0]).error.code, "media_generation_not_configured");
});

test("review 7: janitor accepts only the bare --delete switch -- a value after it or a positional is refused instead of silently becoming a dry run", async () => {
  const calls: string[] = [];
  const core = {
    cleanupExchange: async (input: { dryRun?: boolean }) => {
      calls.push(`janitor:${input.dryRun}`);
      return { scanned: 0, deleted: [], kept: [] };
    },
  } as unknown as MediaGenerationCore;
  const out = capture();
  const run = (argv: string[]) => runMediaCli({ argv, core, operatorCliEnabled: async () => true, assertDeviceAvailable: async () => {}, writeStdout: out.writeStdout });
  assert.equal(await run(["janitor", "--delete", "exchange/"]), 1);
  assert.equal(JSON.parse(out.lines.at(-1)!).error.code, "validation_failed");
  assert.equal(await run(["janitor", "exchange/"]), 1);
  assert.deepEqual(calls, []);
  assert.equal(await run(["janitor"]), 0);
  assert.equal(await run(["janitor", "--delete"]), 0);
  assert.deepEqual(calls, ["janitor:true", "janitor:false"]);
});
