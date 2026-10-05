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

test("viewUrl encodes filename/subfolder/type", () => {
  const client = createComfyUiClient({ baseUrl: "https://x", token: null, authorize: noAuth });
  assert.equal(client.viewUrl({ filename: "a b.png", subfolder: "job1", type: "output" }), "https://x/view?filename=a+b.png&subfolder=job1&type=output");
});
