import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { comfyUiProxyBaseUrl, createComfyUiClient, parseHistoryEntry } from "./comfyui-api";

// Expected shapes from docs.comfy.org/development/comfyui-server/comms_routes and api-examples
// (POST /prompt -> {prompt_id, number} or {error, node_errors}; /history/{id} -> outputs per node).

type Call = { url: string; init: RequestInit };
function fakeFetch(responder: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const noAuth = async () => {};

test("the proxy base URL is built from the pod id and port; a malformed pod id is rejected", () => {
  assert.equal(comfyUiProxyBaseUrl("xedezhzb9la3ye", 8189), "https://xedezhzb9la3ye-8189.proxy.runpod.net");
  assert.throws(() => comfyUiProxyBaseUrl("evil.com/", 8189), (e: unknown) => isDomainError(e) && e.code === "media_settings_invalid");
});

test("submitPrompt posts {prompt, client_id} with the bearer token and returns prompt_id/number", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { prompt_id: "pid-1", number: 3, node_errors: {} } }));
  const client = createComfyUiClient({
    baseUrl: "https://pod-8189.proxy.runpod.net/",
    token: "tok",
    fetchImpl,
    authorize: async (c) => {
      authorized.push(c);
    },
  });
  const result = await client.submitPrompt({ prompt: { "3": { class_type: "KSampler", inputs: {} } }, clientId: "c1" });
  assert.deepEqual(result, { promptId: "pid-1", queueNumber: 3 });
  assert.deepEqual(authorized, ["comfyui_api"]);
  assert.equal(calls[0].url, "https://pod-8189.proxy.runpod.net/prompt");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { prompt: { "3": { class_type: "KSampler", inputs: {} } }, client_id: "c1" });
});

test("a validation failure (400 with node_errors) is comfyui_unavailable carrying the node errors", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { error: { type: "prompt_outputs_failed_validation" }, node_errors: { "3": { errors: [] } } } }));
  const client = createComfyUiClient({ baseUrl: "https://x", token: null, fetchImpl, authorize: noAuth });
  await assert.rejects(client.submitPrompt({ prompt: {} }), (e: unknown) => {
    if (!isDomainError(e) || e.code !== "comfyui_unavailable") return false;
    const body = (e.details as { body?: { node_errors?: unknown } }).body;
    return body?.node_errors !== undefined;
  });
});

test("getHistory returns null until the prompt is in history, then outputs across nodes and kinds", async () => {
  const { fetchImpl } = fakeFetch((call) =>
    call.url.endsWith("/history/pending")
      ? { status: 200, body: {} }
      : {
          status: 200,
          body: {
            done: {
              prompt: [],
              outputs: {
                "9": { images: [{ filename: "job1/img_00001_.png", subfolder: "job1", type: "output" }] },
                "12": { audio: [{ filename: "job1/song.flac", subfolder: "job1", type: "output" }] },
              },
              status: { status_str: "success", completed: true, messages: [["execution_start", {}], ["execution_success", {}]] },
            },
          },
        }
  );
  const client = createComfyUiClient({ baseUrl: "https://x", token: null, fetchImpl, authorize: noAuth });
  assert.equal(await client.getHistory("pending"), null);
  const entry = await client.getHistory("done");
  assert.ok(entry);
  assert.equal(entry.status, "completed");
  assert.deepEqual(entry.statusMessages, ["execution_start", "execution_success"]);
  assert.deepEqual(entry.outputs, [
    { nodeId: "9", kind: "images", filename: "job1/img_00001_.png", subfolder: "job1", type: "output" },
    { nodeId: "12", kind: "audio", filename: "job1/song.flac", subfolder: "job1", type: "output" },
  ]);
});

test("parseHistoryEntry marks an execution error", () => {
  const entry = parseHistoryEntry("p", { p: { outputs: {}, status: { status_str: "error", messages: [["execution_error", { exception_message: "OOM" }]] } } });
  assert.equal(entry?.status, "error");
});

test("a non-2xx or unreachable server is comfyui_unavailable; the gateway block stops the call", async () => {
  const down = createComfyUiClient({ baseUrl: "https://x", token: null, authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 502 })).fetchImpl });
  await assert.rejects(down.getSystemStats(), (e: unknown) => isDomainError(e) && e.code === "comfyui_unavailable");
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const blocked = createComfyUiClient({
    baseUrl: "https://x",
    token: null,
    fetchImpl,
    authorize: async () => {
      throw new Error("off");
    },
  });
  await assert.rejects(blocked.getQueue());
  assert.equal(calls.length, 0);
});

// Review round 6 (ComfyUI server docs: a history entry is `{prompt, outputs, status?}`; the `status` block is
// absent on builds that predate it). A finished prompt is recognised by `status.completed`, by `status_str`
// "success", or -- with no status block at all -- by its outputs; an error is never masked as completed.
test("parseHistoryEntry: an entry with outputs and no status block, or status.completed, is completed; an empty entry without status stays unknown", () => {
  const outputs = { "9": { images: [{ filename: "job1/a.png", subfolder: "job1", type: "output" }] } };
  assert.equal(parseHistoryEntry("p", { p: { prompt: [], outputs } })?.status, "completed");
  assert.equal(parseHistoryEntry("p", { p: { prompt: [], outputs, status: { completed: true, messages: [] } } })?.status, "completed");
  assert.equal(parseHistoryEntry("p", { p: { prompt: [], outputs: {} } })?.status, "unknown");
  assert.equal(parseHistoryEntry("p", { p: { prompt: [], outputs, status: { status_str: "error", completed: false, messages: [] } } })?.status, "error");
  assert.equal(parseHistoryEntry("p", { p: { prompt: [], outputs: {}, status: { completed: false, messages: [] } } })?.status, "unknown");
});

test("the client exposes exactly the calls the job pipeline makes -- no /view or /upload surface nothing exercises", () => {
  const client = createComfyUiClient({ baseUrl: "https://x", token: null, authorize: noAuth });
  assert.deepEqual(Object.keys(client).sort(), ["baseUrl", "deleteQueued", "getHistory", "getQueue", "getSystemStats", "interrupt", "submitPrompt"]);
});

test("review: getQueue exposes the running and pending prompt ids; deleteQueued posts {delete:[...]} and skips an empty list", async () => {
  const { fetchImpl, calls } = fakeFetch((call) =>
    call.init.method === "POST" ? { status: 200, body: {} } : { status: 200, body: { queue_running: [[0, "p-run", {}, {}, []]], queue_pending: [[1, "p-wait", {}, {}, []]] } }
  );
  const client = createComfyUiClient({ baseUrl: "https://x", token: null, fetchImpl, authorize: noAuth });
  assert.deepEqual(await client.getQueue(), { running: 1, pending: 1, runningPromptIds: ["p-run"], pendingPromptIds: ["p-wait"] });
  await client.deleteQueued([]);
  assert.equal(calls.length, 1);
  await client.deleteQueued(["p-wait"]);
  assert.equal(calls[1].url, "https://x/queue");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { delete: ["p-wait"] });
});

test("review 3: an execution error keeps the node and exception message the agent needs", () => {
  const entry = parseHistoryEntry("p", {
    p: { outputs: {}, status: { status_str: "error", messages: [["execution_start", {}], ["execution_error", { node_id: "4", node_type: "CheckpointLoaderSimple", exception_message: "Model not found: big.safetensors" }]] } },
  });
  assert.equal(entry?.status, "error");
  assert.deepEqual(entry?.statusMessages, ["execution_start", "execution_error: Model not found: big.safetensors @ node CheckpointLoaderSimple #4"]);
});
