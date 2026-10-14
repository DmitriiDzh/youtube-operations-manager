import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { CommandView } from "@/lib/media-jobs-pool";
import { createMediaJobCommandsHandlers } from "./route";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.3): a session is required; the channel the command is checked against is the
// session's ACTIVE channel, never a channel named in the body (ADR 0004 (b)); a refusal keeps its code and HTTP status.

const view = { commandId: "c1", state: "waiting" } as unknown as CommandView;

function handlers(options: { session?: boolean; active?: string | null; issue?: () => Promise<CommandView> } = {}) {
  const calls: Array<{ raw: unknown; activeChannelId: string | null }> = [];
  const h = createMediaJobCommandsHandlers({
    getSession: async () => (options.session === false ? null : { user: { id: "u1" } }),
    activeChannelOf: async () => (options.active === undefined ? "UC1" : options.active),
    issue: async (input) => {
      calls.push(input);
      return options.issue ? options.issue() : view;
    },
    list: async () => [view],
  });
  return { ...h, calls };
}

const post = (body: unknown) => new Request("http://x/api/media-jobs/commands", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } });

test("401 without a session: nothing is sent or listed", async () => {
  const h = handlers({ session: false });
  assert.equal((await h.POST(post({ kind: "cancel_job" }))).status, 401);
  assert.equal((await h.GET()).status, 401);
  assert.equal(h.calls.length, 0);
});

test("the active channel is passed, whatever the body says; 202 with the command", async () => {
  const h = handlers({ active: "UC_ACTIVE" });
  const body = { kind: "cancel_job", targetDeviceId: "A", source: "runpod", jobId: "mj_1", channelId: "UC_OTHER" };
  const response = await h.POST(post(body));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { command: view });
  assert.deepEqual(h.calls, [{ raw: body, activeChannelId: "UC_ACTIVE" }]);
});

test("a malformed body is 400; a refusal keeps its code (409 for a command that cannot apply)", async () => {
  assert.equal((await handlers().POST(post("{oops"))).status, 400);
  const refused = handlers({ issue: async () => Promise.reject(new DomainError({ code: "media_job_command_invalid", message: "gone", details: {} })) });
  const response = await refused.POST(post({ kind: "cancel_job" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "media_job_command_invalid");
});

test("GET lists the commands with their answers", async () => {
  const response = await handlers().GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { commands: [view] });
});
