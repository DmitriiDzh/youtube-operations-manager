import assert from "node:assert/strict";
import test from "node:test";
import { createComfyUiClient } from "./comfyui-api";
import { comfyProgressSocketUrl, parseComfyProgressMessage, type ProgressSocket } from "./comfyui-progress";

// BL-144: ComfyUI's websocket messages (docs.comfy.org/development/comfyui-server/comms_messages): every message is
// `{ "type": ..., "data": { ..., "prompt_id": ... } }`. Expected values written by hand from that format.
const msg = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data });

test("parses the documented execution messages of a prompt", () => {
  assert.deepEqual(parseComfyProgressMessage(msg("execution_start", { prompt_id: "p1", timestamp: 1 })), { type: "execution_start", promptId: "p1" });
  assert.deepEqual(parseComfyProgressMessage(msg("execution_cached", { prompt_id: "p1", nodes: ["4", 7] })), {
    type: "execution_cached",
    promptId: "p1",
    nodeIds: ["4", "7"],
  });
  assert.deepEqual(parseComfyProgressMessage(msg("executing", { prompt_id: "p1", node: "3", display_node: "3" })), { type: "executing", promptId: "p1", nodeId: "3" });
  assert.deepEqual(parseComfyProgressMessage(msg("executing", { prompt_id: "p1", node: null })), { type: "executing", promptId: "p1", nodeId: null });
  assert.deepEqual(parseComfyProgressMessage(msg("progress", { prompt_id: "p1", node: "3", value: 18, max: 30 })), {
    type: "progress",
    promptId: "p1",
    nodeId: "3",
    value: 18,
    max: 30,
  });
  assert.deepEqual(parseComfyProgressMessage(msg("executed", { prompt_id: "p1", node: "9", output: { images: [] } })), { type: "executed", promptId: "p1", nodeId: "9" });
  assert.deepEqual(parseComfyProgressMessage(msg("execution_success", { prompt_id: "p1" })), { type: "execution_success", promptId: "p1" });
  assert.deepEqual(parseComfyProgressMessage(msg("execution_interrupted", { prompt_id: "p1", node_id: "3" })), { type: "execution_interrupted", promptId: "p1" });
  assert.deepEqual(
    parseComfyProgressMessage(msg("execution_error", { prompt_id: "p1", node_id: "3", node_type: "KSampler", exception_message: "CUDA out of memory" })),
    { type: "execution_error", promptId: "p1", nodeId: "3", nodeType: "KSampler", message: "CUDA out of memory" }
  );
});

test("parses progress_state (all nodes at once) and skips unknown node states", () => {
  const parsed = parseComfyProgressMessage(
    msg("progress_state", {
      prompt_id: "p1",
      nodes: {
        "3": { value: 5, max: 20, state: "running", node_id: "3", display_node_id: "3" },
        "4": { value: 1, max: 1, state: "finished", node_id: "4" },
        "9": { value: 0, max: 1, state: "weird" },
      },
    })
  );
  assert.deepEqual(parsed, {
    type: "progress_state",
    promptId: "p1",
    nodes: [
      { nodeId: "3", state: "running", value: 5, max: 20 },
      { nodeId: "4", state: "finished", value: 1, max: 1 },
    ],
  });
});

test("ignores what is not a prompt execution event: status, no prompt id, bad JSON, a progress with max 0", () => {
  assert.equal(parseComfyProgressMessage(msg("status", { status: { exec_info: { queue_remaining: 1 } }, sid: "x" })), null);
  assert.equal(parseComfyProgressMessage(msg("progress", { value: 1, max: 2 })), null);
  assert.equal(parseComfyProgressMessage("not json"), null);
  assert.equal(parseComfyProgressMessage(msg("progress", { prompt_id: "p1", value: 1, max: 0 })), null);
});

test("the socket URL is wss on the proxy, with the client id, never the token", () => {
  assert.equal(comfyProgressSocketUrl("https://abc123-8189.proxy.runpod.net/", "ytm-job1"), "wss://abc123-8189.proxy.runpod.net/ws?clientId=ytm-job1");
  assert.equal(comfyProgressSocketUrl("http://127.0.0.1:9000", "c"), "ws://127.0.0.1:9000/ws?clientId=c");
});

function fakeSocketFactory() {
  const opened: Array<{ url: string; headers: Record<string, string>; socket: ProgressSocket & { closedWith?: number } }> = [];
  const factory = (url: string, init: { headers: Record<string, string> }) => {
    const socket: ProgressSocket & { closedWith?: number } = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close(code?: number) {
        this.closedWith = code;
      },
    };
    opened.push({ url, headers: init.headers, socket });
    return socket;
  };
  return { factory, opened };
}

test("openProgressStream: bearer token in the header, events delivered, binary ignored, onClosed exactly once", async () => {
  const { factory, opened } = fakeSocketFactory();
  const categories: string[] = [];
  const client = createComfyUiClient({
    baseUrl: "https://abc123-8189.proxy.runpod.net",
    token: "secret-token",
    authorize: async (c) => {
      categories.push(c);
    },
    socketFactory: factory,
  });
  const events: unknown[] = [];
  const closes: string[] = [];
  const stream = await client.openProgressStream({ clientId: "ytm-j1", onEvent: (e) => events.push(e), onClosed: (r) => closes.push(r) });
  assert.deepEqual(categories, ["comfyui_api"]);
  assert.equal(opened[0].url, "wss://abc123-8189.proxy.runpod.net/ws?clientId=ytm-j1");
  assert.deepEqual(opened[0].headers, { authorization: "Bearer secret-token" });
  assert.ok(!opened[0].url.includes("secret-token"));
  const socket = opened[0].socket;
  socket.onmessage?.({ data: msg("progress", { prompt_id: "p1", node: "3", value: 2, max: 4 }) });
  socket.onmessage?.({ data: new Uint8Array([1, 2, 3]) });
  socket.onmessage?.({ data: msg("status", { status: {} }) });
  assert.deepEqual(events, [{ type: "progress", promptId: "p1", nodeId: "3", value: 2, max: 4 }]);
  socket.onclose?.({ code: 1006, reason: "" });
  stream.close();
  assert.deepEqual(closes, ["closed (1006)"]);
});

test("openProgressStream refuses before connecting when the media gateway is off", async () => {
  const { factory, opened } = fakeSocketFactory();
  const client = createComfyUiClient({
    baseUrl: "https://abc123-8189.proxy.runpod.net",
    token: "t",
    authorize: async () => {
      throw new Error("media_gateway_disabled");
    },
    socketFactory: factory,
  });
  await assert.rejects(client.openProgressStream({ clientId: "c", onEvent: () => {}, onClosed: () => {} }), /media_gateway_disabled/);
  assert.equal(opened.length, 0);
});
