import assert from "node:assert/strict";
import test from "node:test";
import { createJobProgressRegistry, workflowNodeTypes } from "./job-progress";

// BL-144: live job progress only from ComfyUI's own events. A 4-node graph; expected percentages computed by hand:
// percent = floor((nodes done + current node's step fraction) / 4 * 100), at most 99 until execution_success.
const GRAPH = JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple", inputs: {} },
  "2": { class_type: "CLIPTextEncode", inputs: {} },
  "3": { class_type: "KSampler", inputs: {} },
  "4": { class_type: "SaveImage", inputs: {} },
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 6, 20, 0, s));

test("a whole run: waiting → cached → nodes → sampler steps → success", () => {
  const r = createJobProgressRegistry();
  r.begin("j1", { promptId: "p1", workflowJson: GRAPH }, at(0));
  assert.equal(r.get("j1")?.state, "connecting");
  r.connected("j1", at(1));
  assert.deepEqual([r.get("j1")?.state, r.get("j1")?.percent, r.get("j1")?.nodesTotal], ["waiting", 0, 4]);

  r.apply("j1", { type: "execution_start", promptId: "p1" }, at(2));
  r.apply("j1", { type: "execution_cached", promptId: "p1", nodeIds: ["1"] }, at(2));
  let p = r.get("j1")!;
  assert.deepEqual([p.state, p.nodesDone, p.nodesCached, p.percent, p.startedAt], ["running", 1, 1, 25, at(2).toISOString()]);

  r.apply("j1", { type: "executing", promptId: "p1", nodeId: "2" }, at(3));
  r.apply("j1", { type: "executing", promptId: "p1", nodeId: "3" }, at(4));
  p = r.get("j1")!;
  assert.deepEqual([p.nodesDone, p.currentNode, p.percent], [2, { id: "3", type: "KSampler" }, 50]);

  r.apply("j1", { type: "progress", promptId: "p1", nodeId: "3", value: 15, max: 30 }, at(5));
  p = r.get("j1")!;
  assert.deepEqual([p.step, p.percent], [{ value: 15, max: 30 }, 62]); // (2 + 0.5) / 4 = 62.5 → 62

  r.apply("j1", { type: "executed", promptId: "p1", nodeId: "3" }, at(6));
  r.apply("j1", { type: "executing", promptId: "p1", nodeId: "4" }, at(7));
  r.apply("j1", { type: "executed", promptId: "p1", nodeId: "4" }, at(8));
  p = r.get("j1")!;
  assert.equal(p.percent, 99, "every node done, but not 100 before ComfyUI says success");

  r.apply("j1", { type: "execution_success", promptId: "p1" }, at(9));
  p = r.get("j1")!;
  assert.deepEqual([p.state, p.percent, p.currentNode, p.step], ["finished", 100, null, null]);
});

test("events of another prompt are ignored", () => {
  const r = createJobProgressRegistry();
  r.begin("j1", { promptId: "p1", workflowJson: GRAPH }, at(0));
  r.apply("j1", { type: "progress", promptId: "OTHER", nodeId: "3", value: 29, max: 30 }, at(1));
  assert.deepEqual([r.get("j1")?.state, r.get("j1")?.step], ["connecting", null]);
});

test("progress_state marks finished nodes and the running one with its steps", () => {
  const r = createJobProgressRegistry();
  r.begin("j1", { promptId: "p1", workflowJson: GRAPH }, at(0));
  r.apply(
    "j1",
    {
      type: "progress_state",
      promptId: "p1",
      nodes: [
        { nodeId: "1", state: "finished", value: 1, max: 1 },
        { nodeId: "2", state: "finished", value: 1, max: 1 },
        { nodeId: "3", state: "running", value: 3, max: 4 },
        { nodeId: "4", state: "pending", value: 0, max: 1 },
      ],
    },
    at(1)
  );
  const p = r.get("j1")!;
  assert.deepEqual([p.state, p.nodesDone, p.currentNode?.id, p.step, p.percent], ["running", 2, "3", { value: 3, max: 4 }, 68]); // (2 + 0.75)/4
});

test("an error keeps ComfyUI's message; a stream that drops afterwards does not hide it", () => {
  const r = createJobProgressRegistry();
  r.begin("j1", { promptId: "p1", workflowJson: GRAPH }, at(0));
  r.apply("j1", { type: "execution_error", promptId: "p1", nodeId: "3", nodeType: "KSampler", message: "CUDA out of memory" }, at(1));
  r.unavailable("j1", "closed (1006)", at(2));
  const p = r.get("j1")!;
  assert.deepEqual([p.state, p.detail], ["error", "CUDA out of memory · node KSampler #3"]);
});

test("a stream that cannot connect says so; without a graph there is no percent, only node and steps", () => {
  const r = createJobProgressRegistry();
  r.begin("j1", { promptId: "p1", workflowJson: null }, at(0));
  r.unavailable("j1", "error", at(1));
  assert.deepEqual([r.get("j1")?.state, r.get("j1")?.detail], ["unavailable", "error"]);
  r.begin("j2", { promptId: "p2", workflowJson: "not json" }, at(0));
  r.apply("j2", { type: "progress", promptId: "p2", nodeId: "7", value: 2, max: 10 }, at(1));
  const p = r.get("j2")!;
  assert.deepEqual([p.nodesTotal, p.percent, p.currentNode, p.step], [null, null, { id: "7", type: null }, { value: 2, max: 10 }]);
  r.end("j2");
  assert.equal(r.get("j2"), null);
});

test("workflowNodeTypes reads an API-format graph", () => {
  assert.deepEqual([...workflowNodeTypes(GRAPH).entries()], [
    ["1", "CheckpointLoaderSimple"],
    ["2", "CLIPTextEncode"],
    ["3", "KSampler"],
    ["4", "SaveImage"],
  ]);
});
