import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createProductionOperationWait } from "./wait-targets";

// BL-271 (WAIT_TOOLS_PLAN.md AC-WT-10/15, review): every target over its REAL module reads (the runner's temporary database, nothing
// seeded): a well-formed missing id answers exactly `not_found` on the first read -- for the Operator (no scope) and for a worker (its
// channel) alike, so a foreign id (answered as missing by the ports) and a missing one cannot differ; an id a module's own schema
// refuses is `invalid_request` at once, never three failed reads and `target_unavailable`.

const CASES: Array<Record<string, unknown>> = [
  { target: "upload", id: "up_missing" },
  { target: "upload", id: "V999", channelId: "UC_PROD_A" },
  { target: "media_session", id: "ms_missing" },
  { target: "media_job", id: "mj_missing" },
  { target: "gemini_job", id: "gm_missing" },
  { target: "speech_job", id: "gm_missing" },
  { target: "speech_job", id: "el_missing" },
  { target: "sound_job", id: "el_missing" },
  { target: "translation_request", id: "tr_missing", channelId: "UC_PROD_A" },
  { target: "storyboard_review", id: "sb_missing", channelId: "UC_PROD_A" },
  { target: "storyboard_render", id: "rd_missing", channelId: "UC_PROD_A", storyboardId: "sb_missing" },
  { target: "restart", id: "rq_missing" },
];

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error), String(error));
    return { code: error.code, details: error.details };
  }
  assert.fail("expected a refusal");
}

test("real reads: a missing id of every target is not_found at the first read, for the Operator and for a worker", async () => {
  const wait = createProductionOperationWait();
  // Warm-up, untimed: the first call of each target loads its module (and the database) -- under a full parallel run that alone can
  // take seconds. The timed pass below then shows the answer comes from the first read, well inside every poll interval (>= 5 s).
  for (const input of CASES) await codeOf(wait.waitFor({ ...input, timeoutSeconds: 240 }, { channelId: null }));
  for (const scope of [{ channelId: null }, { channelId: "UC_PROD_A" }]) {
    for (const input of CASES) {
      const started = Date.now();
      const answer = await codeOf(wait.waitFor({ ...input, timeoutSeconds: 240 }, scope));
      assert.deepEqual(answer, { code: "not_found", details: { target: input.target, id: input.id } }, `${JSON.stringify(input)} scope ${scope.channelId}`);
      assert.ok(Date.now() - started < 4000, `${input.target}: answered at the first read, not after polling`);
    }
  }
});

test("real reads: an id the module's schema refuses is invalid_request at once (not target_unavailable)", async () => {
  const wait = createProductionOperationWait();
  const started = Date.now();
  assert.equal((await codeOf(wait.waitFor({ target: "storyboard_review", id: "x".repeat(60), channelId: "UC_PROD_A", timeoutSeconds: 240 }, { channelId: null }))).code, "invalid_request");
  assert.ok(Date.now() - started < 5000);
  assert.equal((await codeOf(wait.waitFor({ target: "restart", id: "current", timeoutSeconds: 240 }, { channelId: null }))).code, "no_restart_request");
});
