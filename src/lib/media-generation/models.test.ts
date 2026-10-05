import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError } from "./contracts";
import { buildPullCommand, createMediaModelServices, modelFileName, type ModelPullStore } from "./models";

// AC-P14-18 (docs/roadmap/plans/PHASE_14_PLAN.md): "Add from URL" creates a CPU pod attached to the volume; the pod is terminated
// after success or failure; the listing shows the file afterwards; the GPU session cannot start while a pull runs (checked in
// sessions.test.ts through the hasActivePull hook). The janitor/listing never leave models/.

function fixture(opts: { objects?: Map<string, number>; podStatus?: string; createFails?: boolean } = {}) {
  const objects = opts.objects ?? new Map<string, number>();
  let json: string | null = null;
  const store: ModelPullStore = { getPullsJson: async () => json, setPullsJson: async (j) => void (json = j) };
  const calls: string[] = [];
  let podStatus = opts.podStatus ?? "RUNNING";
  const client = {
    async createPod(input: { cmd?: string[]; cpu?: { id: string; vcpuCount: number }; mounts?: unknown }) {
      calls.push(`createPod:${input.cpu?.id}:${input.cpu?.vcpuCount}`);
      if (opts.createFails) throw new Error("no capacity");
      calls.push(`cmd:${input.cmd?.[2] ?? ""}`);
      return { id: "cpupod1", status: "PROVISIONING", costPerHr: 0.08 };
    },
    async getPod(id: string) {
      calls.push(`getPod:${id}`);
      return podStatus === "GONE" ? null : { id, status: podStatus };
    },
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      podStatus = "GONE";
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const s3 = {
    async listAllObjects(prefix: string) {
      calls.push(`list:${prefix}`);
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, size]) => ({ key, size, lastModified: null, etag: null }));
    },
    async headObject(key: string) {
      const size = objects.get(key);
      return size === undefined ? null : { size, etag: null, lastModified: null };
    },
    async deleteObject(key: string) {
      calls.push(`delete:${key}`);
      objects.delete(key);
    },
  } as unknown as RunpodS3Client;
  let now = new Date("2026-10-05T12:00:00Z");
  let ids = 0;
  const services = createMediaModelServices({
    store,
    base: {
      getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }),
      resolveRunpodClient: async () => client,
      s3: async () => s3,
    },
    generateId: () => `id-${++ids}`,
    clock: { now: () => now },
    pullCapMs: 60 * 60_000,
  });
  return { services, calls, objects, setPodStatus: (s: string) => (podStatus = s), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

test("listModels lists only models/ (folder + name + size), skipping .keep markers", async () => {
  const f = fixture({ objects: new Map([["models/checkpoints/a.safetensors", 100], ["models/vae/.keep", 1], ["exchange/job/x.png", 5], ["models/loras/sub/l.safetensors", 7]]) });
  const models = await f.services.listModels();
  assert.deepEqual(models.map((m) => [m.key, m.folder, m.name, m.bytes]), [
    ["models/checkpoints/a.safetensors", "checkpoints", "a.safetensors", 100],
    ["models/loras/sub/l.safetensors", "loras", "sub/l.safetensors", 7],
  ]);
  assert.deepEqual(f.calls, ["list:models/"]);
});

test("deleteModel accepts only a models/ object key", async () => {
  const f = fixture({ objects: new Map([["models/checkpoints/a.safetensors", 100]]) });
  await assert.rejects(f.services.deleteModel({ key: "exchange/x" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(f.services.deleteModel({ key: "models/checkpoints/" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(f.services.deleteModel({ key: "models/../x" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.deepEqual(await f.services.deleteModel({ key: "models/checkpoints/a.safetensors" }), { deleted: "models/checkpoints/a.safetensors" });
  assert.equal(f.objects.size, 0);
});

test("buildPullCommand downloads into the right folder and quotes the arguments; modelFileName keeps the base name", () => {
  const cmd = buildPullCommand("Comfy-Org/flux1-schnell", "split_files/flux1-schnell-fp8.safetensors", "checkpoints");
  assert.ok(cmd.includes("hf download 'Comfy-Org/flux1-schnell' 'split_files/flux1-schnell-fp8.safetensors' --local-dir /workspace/models/checkpoints"));
  assert.ok(cmd.endsWith("sleep infinity"));
  assert.equal(modelFileName("split_files/x.safetensors"), "x.safetensors");
  assert.ok(buildPullCommand("a/b", "it's.bin", "vae").includes("'it'\\''s.bin'"));
});

test("AC-P14-18: startPull creates a CPU pod on the volume; pollPulls terminates it once the file is on the volume and reports done", async () => {
  const f = fixture();
  const pull = await f.services.startPull({ repoId: "Comfy-Org/flux1-schnell", file: "flux1-schnell-fp8.safetensors", folder: "checkpoints" });
  assert.equal(pull.status, "running");
  assert.equal(pull.podId, "cpupod1");
  assert.equal(pull.expectedKey, "models/checkpoints/flux1-schnell-fp8.safetensors");
  assert.ok(f.calls.includes("createPod:cpu3c:2"));
  assert.equal(await f.services.hasActivePull(), true);
  await assert.rejects(f.services.startPull({ repoId: "a/b", file: "c", folder: "vae" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  // Still downloading.
  const [still] = await f.services.pollPulls();
  assert.equal(still.status, "running");
  assert.ok(!f.calls.includes("terminate:cpupod1"));
  // The file lands.
  f.objects.set("models/checkpoints/flux1-schnell-fp8.safetensors", 123456);
  const [done] = await f.services.pollPulls();
  assert.equal(done.status, "done");
  assert.equal(done.bytes, 123456);
  assert.ok(f.calls.includes("terminate:cpupod1"));
  assert.equal(await f.services.hasActivePull(), false);
  assert.equal((await f.services.listModels()).length, 1);
});

test("AC-P14-18: a pull whose pod dies first fails (pod terminated anyway); one past the cap times out; a creation failure stores nothing", async () => {
  const dies = fixture();
  await dies.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  dies.setPodStatus("EXITED");
  const [failed] = await dies.services.pollPulls();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /EXITED/);
  assert.ok(dies.calls.includes("terminate:cpupod1"));

  const slow = fixture();
  await slow.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  slow.advance(2 * 60 * 60_000);
  const [timeout] = await slow.services.pollPulls();
  assert.equal(timeout.status, "timeout");
  assert.ok(slow.calls.includes("terminate:cpupod1"));

  const broken = fixture({ createFails: true });
  await assert.rejects(broken.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" }));
  assert.deepEqual(await broken.services.listPulls(), []);
});

test("startPull validates the repo id, the file path and the folder", async () => {
  const f = fixture();
  for (const bad of [{ repoId: "nope", file: "x", folder: "vae" }, { repoId: "a/b", file: "../x", folder: "vae" }, { repoId: "a/b", file: "x", folder: "elsewhere" }, { repoId: "a/b", file: "x", folder: "vae", extra: 1 }]) {
    await assert.rejects(f.services.startPull(bad), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  }
  assert.deepEqual(f.calls, []);
});

test("cancelPull terminates a running pull and refuses a finished one", async () => {
  const f = fixture();
  const pull = await f.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  const cancelled = await f.services.cancelPull({ pullId: pull.pullId });
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.error, "cancelled by operator");
  await assert.rejects(f.services.cancelPull({ pullId: pull.pullId }), (e: unknown) => isDomainError(e) && e.code === "media_job_invalid_state");
});

// -- review round 1 (2026-10-05) ------------------------------------------------------------------

test("review: a nested repo file lands under models/<folder>/<repo path> (hf download keeps the path), so that is the key waited for", async () => {
  const f = fixture();
  const pull = await f.services.startPull({ repoId: "Comfy-Org/Wan_2.2", file: "split_files/vae/wan2.2_vae.safetensors", folder: "vae" });
  assert.equal(pull.expectedKey, "models/vae/split_files/vae/wan2.2_vae.safetensors");
  f.objects.set("models/vae/split_files/vae/wan2.2_vae.safetensors", 10);
  assert.equal((await f.services.pollPulls())[0].status, "done");
});

test("review: a pull is never recorded done while its pod could not be terminated -- it stays running and the next poll retries", async () => {
  const g = fixtureWithFlakyTerminate();
  await g.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  g.objects.set("models/vae/c.bin", 5);
  const [first] = await g.services.pollPulls();
  assert.equal(first.status, "running");
  assert.match(first.error ?? "", /could not be terminated/);
  assert.equal(await g.services.hasActivePull(), true);
  const [second] = await g.services.pollPulls();
  assert.equal(second.status, "done");
  assert.equal(await g.services.hasActivePull(), false);
});

function fixtureWithFlakyTerminate() {
  const objects = new Map<string, number>();
  let json: string | null = null;
  let terminateFailures = 1;
  const client = {
    async createPod() {
      return { id: "cpupod1", status: "RUNNING", costPerHr: 0.08 };
    },
    async getPod(id: string) {
      return { id, status: "RUNNING" };
    },
    async terminatePod() {
      if (terminateFailures-- > 0) throw new Error("RunPod API returned HTTP 502");
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const s3 = {
    async listAllObjects() {
      return [];
    },
    async headObject(key: string) {
      const size = objects.get(key);
      return size === undefined ? null : { size, etag: null, lastModified: null };
    },
    async deleteObject() {},
  } as unknown as RunpodS3Client;
  const services = createMediaModelServices({
    store: { getPullsJson: async () => json, setPullsJson: async (j) => void (json = j) },
    base: {
      getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }),
      resolveRunpodClient: async () => client,
      s3: async () => s3,
    },
    generateId: () => "id",
    clock: { now: () => new Date("2026-10-05T12:00:00Z") },
  });
  return { services, objects };
}

test("review 2: concurrent startPull and pollPulls never lose a pull (the list mutations are serialized)", async () => {
  const f = fixture();
  await f.services.startPull({ repoId: "a/b", file: "first.bin", folder: "vae" });
  f.objects.set("models/vae/first.bin", 5);
  // A poll (which finishes the first pull) and a second start race on the same JSON list.
  const [, second] = await Promise.all([f.services.pollPulls(), (async () => {
    await new Promise((r) => setTimeout(r, 0));
    return f.services.startPull({ repoId: "a/b", file: "second.bin", folder: "vae" }).catch(() => null);
  })()]);
  const pulls = await f.services.listPulls();
  if (second) assert.ok(pulls.some((p) => p.pullId === second.pullId && p.status === "running"), "the second pull must be in the list");
  assert.ok(pulls.some((p) => p.expectedKey === "models/vae/first.bin" && p.status === "done"));
});

test("review 3: a pull is refused while a GPU session is open on the volume", async () => {
  const objects = new Map<string, number>();
  let json: string | null = null;
  const client = { async createPod() { throw new Error("must not be reached"); } } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject() { return null; }, async deleteObject() {} } as unknown as RunpodS3Client;
  const services = createMediaModelServices({
    store: { getPullsJson: async () => json, setPullsJson: async (j) => void (json = j) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "id",
    clock: { now: () => new Date() },
    hasOpenPod: async () => true,
  });
  void objects;
  await assert.rejects(services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  assert.deepEqual(await services.listPulls(), []);
});

test("review 4: the Hugging Face CLI's .cache litter is not listed as a model", async () => {
  const f = fixture({ objects: new Map([["models/checkpoints/a.safetensors", 100], ["models/checkpoints/.cache/huggingface/download/a.safetensors.metadata", 1], ["models/checkpoints/.cache/huggingface/download/a.safetensors.incomplete", 50]]) });
  assert.deepEqual((await f.services.listModels()).map((m) => m.key), ["models/checkpoints/a.safetensors"]);
});
