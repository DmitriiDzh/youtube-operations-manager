import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError } from "./contracts";
import { buildPullCommand, createMediaModelServices, modelFileName, type MediaControlEvent, type ModelPull, type ModelPullStore, type ModelServiceDependencies } from "./models";
import { createMemoryVolumeLockStore, createVolumeLock } from "./volume-lock";


// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.1): a pull is now checked against the Hugging Face Hub before any pod and is
// settled by the pod's verdict file. The Phase-14 tests below keep their lifecycle expectations; this harness supplies
// the two new dependencies and emulates the pod's contract -- once its file is at the final key, its verdict
// `ytm-pulls/<pullId>.json` says ok with the expected hash and the file's size -- unless a test sets a verdict itself.
const HUB_SHA = "b".repeat(64);
type Verdicts = Map<string, string>;
function fakeHub(info: Partial<{ sha256: string | null; bytes: number; commitSha: string }> = {}, calls?: string[]): ModelServiceDependencies["hub"] {
  return {
    async getFileInfo(input) {
      calls?.push(`hub:${input.repoId}:${input.file}:${input.revision ?? "main"}`);
      return { repoId: input.repoId, revision: input.revision ?? "main", commitSha: info.commitSha ?? "c0ffee", path: input.file, bytes: info.bytes ?? 1000, sha256: info.sha256 === undefined ? HUB_SHA : info.sha256 };
    },
  };
}
function createTestModelServices(
  deps: Omit<ModelServiceDependencies, "hub" | "events"> & Partial<Pick<ModelServiceDependencies, "hub" | "events">>,
  options: { verdicts?: Verdicts; podWritesVerdict?: boolean } = {}
) {
  const verdicts = options.verdicts ?? new Map<string, string>();
  const podWritesVerdict = options.podWritesVerdict ?? true;
  const s3 = async () => {
    const inner = await deps.base.s3();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "getObjectText") {
          return async (key: string) => {
            if (verdicts.has(key)) return verdicts.get(key)!;
            const match = /^ytm-pulls\/(.+)\.json$/.exec(key);
            if (!match || !podWritesVerdict) return null;
            const pull = (JSON.parse((await deps.store.getPullsJson()) ?? "[]") as ModelPull[]).find((p) => p.pullId === match[1]);
            const head = pull ? await target.headObject(pull.expectedKey) : null;
            return pull && head ? JSON.stringify({ ok: true, sha256: pull.expectedSha256, bytes: head.size }) : null;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (value === undefined && prop === "deleteObject") return async () => {};
        if (value === undefined && prop === "listAllObjects") return async () => [];
        return value;
      },
    });
  };
  const resolveRunpodClient = async () => {
    const inner = await deps.base.resolveRunpodClient();
    return new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (value === undefined && prop === "getNetworkVolume") return async () => null; // size unknown: no free-space check
        return value;
      },
    });
  };
  return createMediaModelServices({
    ...deps,
    hub: deps.hub ?? fakeHub(),
    events: deps.events ?? { record: async () => {} },
    base: { ...deps.base, s3, resolveRunpodClient },
  });
}

/** A lock whose holder is "active" exactly while held (no cross-module staleness check in these unit tests). */
function testLock(opts: { heldBy?: string } = {}) {
  const store = createMemoryVolumeLockStore();
  if (opts.heldBy) void store.tryAcquire(opts.heldBy, new Date(0)); // an old, active holder
  return { lock: createVolumeLock({ store, isHolderActive: async () => true }), store };
}

// AC-P14-18 (docs/roadmap/plans/PHASE_14_PLAN.md): "Add from URL" creates a CPU pod attached to the volume; the pod is terminated
// after success or failure; the listing shows the file afterwards; the GPU session cannot start while a pull runs (checked in
// sessions.test.ts through the hasActivePull hook). The janitor/listing never leave models/.

function fixture(
  opts: {
    objects?: Map<string, number>;
    podStatus?: string;
    createFails?: boolean;
    hub?: ModelServiceDependencies["hub"];
    volume?: { sizeGb: number; usedSizeGb: number | null } | null;
    verdicts?: Verdicts;
    podWritesVerdict?: boolean;
  } = {}
) {
  const objects = opts.objects ?? new Map<string, number>();
  let json: string | null = null;
  const store: ModelPullStore = { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) };
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
    async listPods() {
      return []; // RunPod reachable: no pod of the deterministic name exists
    },
    ...(opts.volume !== undefined
      ? {
          async getNetworkVolume(id: string) {
            calls.push(`volume:${id}`);
            return opts.volume === null ? null : { id, name: "v", dataCenterId: "EU-RO-1", ...opts.volume };
          },
        }
      : {}),
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
  const events: MediaControlEvent[] = [];
  const verdicts = opts.verdicts ?? new Map<string, string>();
  const services = createTestModelServices(
    {
      store,
      hub: opts.hub,
      events: { record: async (e) => void events.push(e) },
      base: {
        getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }),
        resolveRunpodClient: async () => client,
        s3: async () => s3,
      },
      generateId: () => `id-${++ids}`,
      clock: { now: () => now },
      pullCapMs: 60 * 60_000,
      volumeLock: testLock().lock,
    },
    { verdicts, podWritesVerdict: opts.podWritesVerdict }
  );
  return { services, calls, objects, events, verdicts, pulls: () => JSON.parse(json ?? "[]") as ModelPull[], setPodStatus: (s: string) => (podStatus = s), advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
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

test("BL-132 buildPullCommand: downloads the exact commit into the pull's staging folder, hashes it there, moves it into models/ only on a match, writes the verdict via .part + rename; arguments are quoted", () => {
  const cmd = buildPullCommand({ pullId: "p1", repoId: "Comfy-Org/flux1-schnell", file: "split_files/flux1-schnell-fp8.safetensors", folder: "checkpoints", commitSha: "abc123", expectedSha256: "e".repeat(64) });
  const lines = cmd.split("\n");
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.equal(lines[0], "set -e");
  assert.ok(lines.includes("trap 'rm -rf /workspace/ytm-staging/p1' EXIT"), "staging removed on any exit");
  assert.ok(cmd.includes("hf download 'Comfy-Org/flux1-schnell' 'split_files/flux1-schnell-fp8.safetensors' --revision 'abc123' --local-dir /workspace/ytm-staging/p1"));
  assert.ok(cmd.includes("sha256sum /workspace/ytm-staging/p1/'split_files/flux1-schnell-fp8.safetensors'"));
  assert.ok(cmd.includes(`if [ "$ACTUAL" = '${"e".repeat(64)}' ]; then`));
  assert.ok(cmd.includes("mv /workspace/ytm-staging/p1/'split_files/flux1-schnell-fp8.safetensors' /workspace/models/checkpoints/'split_files/flux1-schnell-fp8.safetensors'; OK=true; else OK=false; fi"));
  // Order: download -> hash -> conditional move -> staging gone -> verdict written last, atomically.
  assert.ok(at("hf download") < at("sha256sum") && at("sha256sum") < at("then mkdir") && at("then mkdir") < lines.indexOf("rm -rf /workspace/ytm-staging/p1") && lines.indexOf("rm -rf /workspace/ytm-staging/p1") < at("> /workspace/ytm-pulls/p1.json.part"));
  assert.ok(lines.includes("mv /workspace/ytm-pulls/p1.json.part /workspace/ytm-pulls/p1.json"));
  assert.ok(cmd.endsWith("sleep infinity"));
  assert.ok(!cmd.includes("/workspace/models/checkpoints --local-dir") && !/--local-dir \/workspace\/models/.test(cmd), "never downloads straight into models/");
  assert.equal(modelFileName("split_files/x.safetensors"), "x.safetensors");
  assert.ok(buildPullCommand({ pullId: "p", repoId: "a/b", file: "it's.bin", folder: "vae", commitSha: "c", expectedSha256: "f".repeat(64) }).includes("'it'\\''s.bin'"));
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

  // Review round 8: a pull is RESERVED before its createPod (so a concurrent approve sees it); a creation failure
  // therefore leaves a terminal `failed` record (never a running one) -- the volume is free and no pod exists.
  const broken = fixture({ createFails: true });
  await assert.rejects(broken.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" }));
  const [record] = await broken.services.listPulls();
  assert.equal(record.status, "failed");
  assert.equal(record.podId, null);
  assert.match(record.error ?? "", /pod creation failed/);
  assert.equal(await broken.services.hasActivePull(), false);
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
  let gone = false;
  const client = {
    async createPod() {
      return { id: "cpupod1", status: "RUNNING", costPerHr: 0.08 };
    },
    async getPod(id: string) {
      return gone ? null : { id, status: "RUNNING" };
    },
    async terminatePod() {
      if (terminateFailures-- > 0) throw new Error("RunPod API returned HTTP 502");
      gone = true;
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
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: {
      getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }),
      resolveRunpodClient: async () => client,
      s3: async () => s3,
    },
    generateId: () => "id",
    clock: { now: () => new Date("2026-10-05T12:00:00Z") },
    volumeLock: testLock().lock,
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
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "id",
    clock: { now: () => new Date() },
    volumeLock: testLock({ heldBy: "session:s-open" }).lock, // an open GPU session holds the volume lock
  });
  void objects;
  await assert.rejects(services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  assert.deepEqual(await services.listPulls(), [], "refused before anything is recorded");
});

test("review 4: the Hugging Face CLI's .cache litter is not listed as a model", async () => {
  const f = fixture({ objects: new Map([["models/checkpoints/a.safetensors", 100], ["models/checkpoints/.cache/huggingface/download/a.safetensors.metadata", 1], ["models/checkpoints/.cache/huggingface/download/a.safetensors.incomplete", 50]]) });
  assert.deepEqual((await f.services.listModels()).map((m) => m.key), ["models/checkpoints/a.safetensors"]);
});

// -- review round 5 (2026-10-05) ------------------------------------------------------------------

test("review 5: a pull is terminal only once RunPod confirms the pod is gone; a pod that lingers keeps the pull running (volume still busy)", async () => {
  const objects = new Map<string, number>(); // the file lands after the pull starts (a pre-existing key is refused since review round 7)
  let json: string | null = null;
  let status = "RUNNING";
  const client = {
    async createPod() {
      return { id: "cpupod1", status: "RUNNING", costPerHr: 0.08 };
    },
    async getPod(id: string) {
      return status === "GONE" ? null : { id, status };
    },
    async terminatePod() {
      return { terminated: true, alreadyGone: false }; // accepted, but the container lingers
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject(key: string) { const size = objects.get(key); return size === undefined ? null : { size, etag: null, lastModified: null }; }, async deleteObject() {} } as unknown as RunpodS3Client;
  let now = new Date("2026-10-05T12:00:00Z");
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "id",
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    volumeLock: testLock().lock,
  });
  await services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  objects.set("models/vae/c.bin", 5);
  const [lingering] = await services.pollPulls();
  assert.equal(lingering.status, "running");
  assert.match(lingering.error ?? "", /still RUNNING after terminate/);
  assert.equal(await services.hasActivePull(), true);
  status = "GONE";
  const [done] = await services.pollPulls();
  assert.equal(done.status, "done");
  assert.equal(await services.hasActivePull(), false);
});

test("review 5: a createPod call that fails after RunPod created the pull pod still records the pull (found by its deterministic name)", async () => {
  let json: string | null = null;
  const client = {
    async createPod(input: { name: string }) {
      void input;
      throw new Error("RunPod API request failed: The operation was aborted due to timeout");
    },
    async listPods() {
      return [{ id: "cpupod9", name: "ytm-models-pull-pull-abc", status: "RUNNING" }];
    },
    async getPod(id: string) {
      return { id, status: "RUNNING" };
    },
    async terminatePod() {
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject() { return null; }, async deleteObject() {} } as unknown as RunpodS3Client;
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "pull-abcdef",
    clock: { now: () => new Date() },
    volumeLock: testLock().lock,
  });
  const pull = await services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  assert.equal(pull.podId, "cpupod9");
  assert.equal(await services.hasActivePull(), true);
});

// -- review round 6 (2026-10-05) ------------------------------------------------------------------

test("review 6: two PROCESSES (the web watch loop and the operator CLI) mutating the pulls list never lose a pull -- the store's read-modify-write is atomic per mutation, not a whole-list overwrite from a stale read", async () => {
  // One shared store (the database), two independent service instances (two processes, two serialization chains).
  let json: string | null = null;
  const store: ModelPullStore = { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) };
  const objects = new Map<string, number>();
  let headCalls = 0;
  let releaseHead: () => void = () => undefined;
  const headGate = new Promise<void>((resolve) => (releaseHead = resolve));
  const s3 = {
    async headObject(key: string) {
      headCalls++;
      // Call 1 is startPull's own "does the key exist" check (review round 7); call 2 is the web loop's slow poll,
      // during which the CLI appends a pull.
      if (headCalls === 2) await headGate;
      const size = objects.get(key);
      return size === undefined ? null : { size, etag: null, lastModified: null };
    },
    async listAllObjects() {
      return [];
    },
    async deleteObject() {},
  } as unknown as RunpodS3Client;
  let created = 0;
  const client = {
    async createPod() {
      created++;
      return { id: `cpupod${created}`, status: "PROVISIONING" };
    },
    async getPod(id: string) {
      return { id, status: "TERMINATED" };
    },
    async terminatePod() {
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const sharedLock = testLock();
  const make = (prefix: string) =>
    createTestModelServices({
      store,
      base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
      generateId: () => `${prefix}-${Math.random().toString(36).slice(2, 8)}`,
      clock: { now: () => new Date("2026-10-05T12:00:00Z") },
      volumeLock: sharedLock.lock, // one database -> one lock for both processes
    });
  const web = make("web");
  const cli = make("cli");
  const a = await web.startPull({ repoId: "a/b", file: "first.bin", folder: "vae" });
  objects.set("models/vae/first.bin", 5);
  const webPoll = web.pollPulls(); // reads [A], then blocks in headObject
  await new Promise((r) => setTimeout(r, 0));
  // The CLI (another process) cannot see an active pull as "already running"? It can -- so simulate its append the way
  // its own startPull writes: a merge against the current list (A is done from its point of view only after the poll).
  // Here the CLI records its pull directly through the shared store, exactly as startPull does once its checks pass.
  await store.updatePullsJson((current) => JSON.stringify([...JSON.parse(current ?? "[]"), { pullId: "cli-B", podId: "cpupod2", repoId: "a/b", file: "second.bin", expectedKey: "models/vae/second.bin", status: "running", startedAt: "2026-10-05T12:00:00.000Z", finishedAt: null, bytes: null, error: null }]));
  releaseHead();
  await webPoll;
  const pulls = await cli.listPulls();
  assert.equal(pulls.find((p) => p.pullId === a.pullId)?.status, "done");
  assert.equal(pulls.find((p) => p.pullId === "cli-B")?.status, "running", "the pull appended by the other process survives the web loop's write");
  assert.equal(await web.hasActivePull(), true, "the volume is still reported busy (AC-P14-18)");
});

test("review 6: listPulls is read-only -- it never terminates a pod or rewrites the list (a GET/listing must not mutate)", async () => {
  const f = fixture();
  await f.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  f.objects.set("models/vae/c.bin", 10);
  const before = f.calls.length;
  const [pull] = await f.services.listPulls();
  assert.equal(pull.status, "running");
  assert.equal(f.calls.length, before, "no RunPod/S3 call from a listing");
  assert.ok(!f.calls.includes("terminate:cpupod1"));
});

test("review 7: pulling a file whose key already exists on the volume is refused before any pod is created (the poll would call it done at once); after a delete it is accepted", async () => {
  const f = fixture({ objects: new Map([["models/vae/ae.safetensors", 1000]]) });
  await assert.rejects(f.services.startPull({ repoId: "a/b", file: "ae.safetensors", folder: "vae" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed" && /already exists/.test(e.message));
  assert.ok(!f.calls.some((c) => c.startsWith("createPod")));
  await f.services.deleteModel({ key: "models/vae/ae.safetensors" });
  const pull = await f.services.startPull({ repoId: "a/b", file: "ae.safetensors", folder: "vae" });
  assert.equal(pull.status, "running");
});

// -- review round 8 (2026-10-05) ------------------------------------------------------------------

test("review 8/9 (AC-P14-18 as a constraint): the pull holds the volume lock from before its createPod until it is terminal; a session cannot take it meanwhile, and a crash-stale holder is stolen", async () => {
  let releaseCreate: () => void = () => undefined;
  const gate = new Promise<void>((r) => (releaseCreate = r));
  const objects = new Map<string, number>();
  let json: string | null = null;
  let terminated = false;
  const client = {
    async createPod() {
      await gate;
      return { id: "cpupod1", status: "PROVISIONING", costPerHr: 0.08 };
    },
    async getPod(id: string) {
      return { id, status: terminated ? "TERMINATED" : "RUNNING" };
    },
    async terminatePod() {
      terminated = true;
      return { terminated: true, alreadyGone: false };
    },
    async listPods() {
      return [];
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject(key: string) { const size = objects.get(key); return size === undefined ? null : { size, etag: null, lastModified: null }; }, async deleteObject() {} } as unknown as RunpodS3Client;
  const { lock, store } = testLock();
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "pull-1",
    clock: { now: () => new Date("2026-10-05T12:00:00Z") },
    volumeLock: lock,
  });
  const starting = services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  await new Promise((r) => setTimeout(r, 0));
  // While RunPod is still creating the pod: the lock is already the pull's -- a session approve would be refused here.
  assert.equal(store.current(), "pull:pull-1");
  await assert.rejects(lock.acquire("session:s1"), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /model pull \(pull-1\)/.test(e.message));
  releaseCreate();
  const pull = await starting;
  assert.equal(pull.podId, "cpupod1");
  // Done -> the lock is released with the terminal write.
  objects.set("models/vae/c.bin", 7);
  await services.pollPulls();
  assert.equal(store.current(), null);
  await lock.acquire("session:s1");
  await lock.release("session:s1");

  // A holder that is no longer active (crash between its terminal write and its release) is stolen by the next acquire.
  const stale = createMemoryVolumeLockStore();
  await stale.tryAcquire("session:dead", new Date(0)); // long past the staleness grace
  const stealing = createVolumeLock({ store: stale, isHolderActive: async (h) => h !== "session:dead" });
  await stealing.acquire("pull:p2");
  assert.equal(stale.current(), "pull:p2");
});

test("review 8: a reservation whose createPod never returned is settled by the poll after a grace period -- adopted when a pod of its name exists, voided otherwise", async () => {
  // Simulate a process that died inside createPod: a reserved record with no pod.
  const now = new Date("2026-10-05T12:00:00Z");
  const reserved = { pullId: "r1", podId: null, repoId: "a/b", file: "c.bin", expectedKey: "models/vae/c.bin", status: "running", startedAt: now.toISOString(), finishedAt: null, bytes: null, error: null };
  let json: string | null = JSON.stringify([reserved]);
  const objects = new Map<string, number>();
  let pods: Array<{ id: string; name: string; status: string }> = [];
  const client = {
    async listPods() {
      return pods;
    },
    async getPod(id: string) {
      return { id, status: "RUNNING" };
    },
    async terminatePod() {
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject(key: string) { const size = objects.get(key); return size === undefined ? null : { size, etag: null, lastModified: null }; }, async deleteObject() {} } as unknown as RunpodS3Client;
  let clock = now;
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "x",
    clock: { now: () => clock },
    volumeLock: testLock().lock,
  });
  // Inside the grace period: left alone (its startPull may still be inside createPod).
  assert.equal((await services.pollPulls())[0].podId, null);
  assert.equal(await services.hasActivePull(), true);
  // Past it, a pod of the deterministic name exists -> adopted.
  clock = new Date(now.getTime() + 3 * 60_000);
  pods = [{ id: "cpupod7", name: "ytm-models-pull-r1", status: "RUNNING" }];
  assert.equal((await services.pollPulls())[0].podId, "cpupod7");
  // Another reservation past the grace with no pod -> void.
  json = JSON.stringify([{ ...reserved, pullId: "r2" }]);
  pods = [];
  const [voided] = await services.pollPulls();
  assert.equal(voided.status, "failed");
  assert.match(voided.error ?? "", /no pod was ever created/);
  assert.equal(await services.hasActivePull(), false);
});

test("review 10: a pull settled by another process while this one was inside createPod is NOT resurrected -- the just-created pod is terminated and the stored verdict stands", async () => {
  let releaseCreate: () => void = () => undefined;
  const gate = new Promise<void>((r) => (releaseCreate = r));
  let json: string | null = null;
  const calls: string[] = [];
  let terminated = false;
  const client = {
    async createPod() {
      await gate;
      return { id: "cpupod1", status: "PROVISIONING" };
    },
    async getPod(id: string) {
      return { id, status: terminated ? "TERMINATED" : "RUNNING" };
    },
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      terminated = true;
      return { terminated: true, alreadyGone: false };
    },
    async listPods() {
      return [];
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject() { return null; }, async deleteObject() {} } as unknown as RunpodS3Client;
  const { lock, store } = testLock();
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "pull-1",
    clock: { now: () => new Date("2026-10-05T12:00:00Z") },
    volumeLock: lock,
  });
  const starting = services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  await new Promise((r) => setTimeout(r, 0));
  // The web UI (another process, not this one's serialized chain) cancels the reserved pull and the lock is released.
  json = JSON.stringify((JSON.parse(json ?? "[]") as Array<Record<string, unknown>>).map((p) => ({ ...p, status: "failed", error: "cancelled by operator", finishedAt: "2026-10-05T12:00:01.000Z" })));
  await store.release("pull:pull-1");
  releaseCreate();
  await assert.rejects(starting, (e: unknown) => isDomainError(e) && e.code === "media_job_invalid_state" && /was failed before its pod was recorded/.test(e.message));
  assert.deepEqual(calls, ["terminate:cpupod1"]);
  const [stored] = await services.listPulls();
  assert.equal(stored.status, "failed");
  assert.equal(stored.podId, null);
  assert.equal(store.current(), null);
  assert.equal(await services.hasActivePull(), false);
});

test("review 16: cancelling a RESERVED pull first looks for a pod of its deterministic name -- one that exists is terminated, never orphaned; while RunPod cannot be asked the reservation stays", async () => {
  let json: string | null = JSON.stringify([{ pullId: "r1", podId: null, repoId: "a/b", file: "c.bin", expectedKey: "models/vae/c.bin", status: "running", startedAt: "2026-10-05T12:00:00.000Z", finishedAt: null, bytes: null, error: null }]);
  const calls: string[] = [];
  let listPodsDown = true;
  let terminated = false;
  const client = {
    async listPods() {
      if (listPodsDown) throw new Error("RunPod API returned HTTP 503");
      return [{ id: "cpupod5", name: "ytm-models-pull-r1", status: "RUNNING" }];
    },
    async getPod(id: string) {
      return { id, status: terminated ? "TERMINATED" : "RUNNING" };
    },
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      terminated = true;
      return { terminated: true, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const s3 = { async listAllObjects() { return []; }, async headObject() { return null; }, async deleteObject() {} } as unknown as RunpodS3Client;
  const { lock, store } = testLock();
  await store.tryAcquire("pull:r1", new Date(0));
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => s3 },
    generateId: () => "x",
    clock: { now: () => new Date("2026-10-05T12:00:30Z") },
    volumeLock: lock,
  });
  await assert.rejects(services.cancelPull({ pullId: "r1" }), (e: unknown) => isDomainError(e) && e.code === "runpod_api_unavailable");
  assert.equal(await services.hasActivePull(), true, "still reserved");
  assert.equal(store.current(), "pull:r1");
  listPodsDown = false;
  const cancelled = await services.cancelPull({ pullId: "r1" });
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.podId, "cpupod5", "the pod found by name is recorded");
  assert.deepEqual(calls, ["terminate:cpupod5"]);
  assert.equal(store.current(), null);
});

test("review 17: after a pull ends, the HF CLI's cache keys under models/<folder>/.cache/ are deleted over S3 (the pod may have been killed before its own cleanup ran)", async () => {
  const f = fixture();
  await f.services.startPull({ repoId: "a/b", file: "c.bin", folder: "vae" });
  f.objects.set("models/vae/c.bin", 10);
  f.objects.set("models/vae/.cache/huggingface/download/c.bin.metadata", 1);
  f.objects.set("models/vae/.cache/huggingface/download/c.bin.lock", 0);
  f.objects.set("models/checkpoints/.cache/other.lock", 0); // another folder: untouched
  const [done] = await f.services.pollPulls();
  assert.equal(done.status, "done");
  assert.ok(f.calls.includes("delete:models/vae/.cache/huggingface/download/c.bin.metadata"));
  assert.ok(f.calls.includes("delete:models/vae/.cache/huggingface/download/c.bin.lock"));
  assert.ok(f.objects.has("models/checkpoints/.cache/other.lock"));
  assert.ok(f.objects.has("models/vae/c.bin"));
});

test("review 18: a flaky S3 does not hide a dead pull pod or the 6 h cap -- each poll check stands on its own", async () => {
  // A running pull whose pod died while S3 answers 503 to every HEAD.
  let json: string | null = JSON.stringify([{ pullId: "p1", podId: "cpupod1", repoId: "a/b", file: "c.bin", expectedKey: "models/vae/c.bin", status: "running", startedAt: "2026-10-05T12:00:00.000Z", finishedAt: null, bytes: null, error: null }]);
  const calls: string[] = [];
  const client = {
    async getPod(id: string) {
      return { id, status: calls.includes(`terminate:${id}`) ? "TERMINATED" : "EXITED" };
    },
    async terminatePod(id: string) {
      calls.push(`terminate:${id}`);
      return { terminated: true, alreadyGone: false };
    },
    async listPods() {
      return [];
    },
  } as unknown as RunpodApiClient;
  const flakyS3 = { async listAllObjects() { return []; }, async headObject() { throw new Error("RunPod S3 returned HTTP 503"); }, async deleteObject() {} } as unknown as RunpodS3Client;
  const { lock, store } = testLock();
  await store.tryAcquire("pull:p1", new Date(0));
  const services = createTestModelServices({
    store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: async () => client, s3: async () => flakyS3 },
    generateId: () => "x",
    clock: { now: () => new Date("2026-10-05T12:05:00Z") },
    volumeLock: lock,
  });
  const [settled] = await services.pollPulls();
  assert.equal(settled.status, "failed", "the dead pod was noticed although S3 was down");
  assert.match(settled.error ?? "", /pod EXITED before the file appeared/);
  assert.deepEqual(calls, ["terminate:cpupod1"]);
  assert.equal(store.current(), null);
});

test("review 20: an unusable S3 pair does not skip the dead-pod check and the cap, and an unusable RunPod client does not skip the file check", async () => {
  const base = (over: { s3?: () => Promise<RunpodS3Client>; client?: () => Promise<RunpodApiClient> }) => {
    let json: string | null = JSON.stringify([{ pullId: "p1", podId: "cpupod1", repoId: "a/b", file: "c.bin", expectedKey: "models/vae/c.bin", status: "running", startedAt: "2026-10-05T12:00:00.000Z", finishedAt: null, bytes: null, error: null }]);
    const calls: string[] = [];
    const client = { async getPod(id: string) { return { id, status: calls.includes(`terminate:${id}`) ? "TERMINATED" : "EXITED" }; }, async terminatePod(id: string) { calls.push(`terminate:${id}`); return { terminated: true, alreadyGone: false }; }, async listPods() { return []; } } as unknown as RunpodApiClient;
    const s3 = { async listAllObjects() { return []; }, async headObject() { return { size: 7, etag: null, lastModified: null }; }, async deleteObject() {} } as unknown as RunpodS3Client;
    const { lock, store } = testLock();
    void store.tryAcquire("pull:p1", new Date(0));
    const services = createTestModelServices({
      store: { getPullsJson: async () => json, updatePullsJson: async (m) => (json = m(json)) },
      base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "vol-eu" }), resolveRunpodClient: over.client ?? (async () => client), s3: over.s3 ?? (async () => s3) },
      generateId: () => "x",
      clock: { now: () => new Date("2026-10-05T12:05:00Z") },
      volumeLock: lock,
    });
    return { services, calls };
  };
  const noS3 = base({ s3: async () => { throw new Error("no S3 key pair"); } });
  const [a] = await noS3.services.pollPulls();
  assert.equal(a.status, "failed", "the dead pod was noticed without S3");
  assert.deepEqual(noS3.calls, ["terminate:cpupod1"]);
  const noRunpod = base({ client: async () => { throw new Error("no credentials"); } });
  const [b] = await noRunpod.services.pollPulls();
  assert.equal(b.status, "running", "done needs the terminate, which needs RunPod -- the pull stays running with the error recorded");
  assert.match(b.error ?? "", /could not be terminated/);
});

// -- BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.1, AC-FM-01..04, AC-FM-14): verified pulls -------------------------------
// Expected values are stated from the plan and the owner's decision D2 ("the request carries the expected hash; a mismatch
// deletes the file and fails the pull"), not read off the implementation.

const WANT = "1".repeat(64);
const OTHER = "2".repeat(64);

test("AC-FM-01: a requested SHA-256 that differs from the Hub's declared hash is refused before any pod is created -- nothing billed or stored", async () => {
  const f = fixture({ hub: fakeHub({ sha256: OTHER }) });
  await assert.rejects(
    f.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints", sha256: WANT }),
    (e: unknown) => isDomainError(e) && e.code === "media_model_hash_mismatch"
  );
  assert.ok(!f.calls.some((c) => c.startsWith("createPod")));
  assert.deepEqual(f.pulls(), []);
  assert.equal(await f.services.hasActivePull(), false);
});

test("AC-FM-01: a gated repo, an unknown file and the Hub being down all refuse the pull before any pod", async () => {
  for (const code of ["media_model_gated", "media_model_not_found", "huggingface_unavailable"] as const) {
    const f = fixture({
      hub: {
        async getFileInfo() {
          const { DomainError } = await import("./contracts");
          throw new DomainError({ code, message: code });
        },
      },
    });
    await assert.rejects(f.services.startPull({ repoId: "a/b", file: "m", folder: "vae", sha256: WANT }), (e: unknown) => isDomainError(e) && e.code === code);
    assert.ok(!f.calls.some((c) => c.startsWith("createPod")));
  }
});

test("D2: without a requested hash the Hub's declared one is used; a non-LFS file (no declared hash) needs it explicitly", async () => {
  const declared = fixture({ hub: fakeHub({ sha256: WANT }) });
  const pull = await declared.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "vae" });
  assert.equal(pull.expectedSha256, WANT);
  assert.ok(declared.calls.some((c) => c.includes(`'${WANT}'`)), "the pod checks against that hash");

  const plain = fixture({ hub: fakeHub({ sha256: null }) });
  await assert.rejects(plain.services.startPull({ repoId: "a/b", file: "cfg.json", folder: "vae" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  const explicit = await plain.services.startPull({ repoId: "a/b", file: "cfg.json", folder: "vae", sha256: WANT.toUpperCase() });
  assert.equal(explicit.expectedSha256, WANT, "stored lower-case");
});

test("AC-FM-04: a file larger than the volume's free space is refused (media_volume_full) before any pod; a volume of unknown usage is not a refusal", async () => {
  const full = fixture({ hub: fakeHub({ bytes: 11e9 }), volume: { sizeGb: 50, usedSizeGb: 40 } });
  await assert.rejects(full.services.startPull({ repoId: "a/b", file: "big.safetensors", folder: "checkpoints" }), (e: unknown) => isDomainError(e) && e.code === "media_volume_full" && (e.details as { freeBytes: number }).freeBytes === 10e9);
  assert.ok(!full.calls.some((c) => c.startsWith("createPod")));
  const fits = fixture({ hub: fakeHub({ bytes: 9e9 }), volume: { sizeGb: 50, usedSizeGb: 40 } });
  assert.equal((await fits.services.startPull({ repoId: "a/b", file: "ok.safetensors", folder: "checkpoints" })).status, "running");
  const unknown = fixture({ hub: fakeHub({ bytes: 999e9 }), volume: { sizeGb: 50, usedSizeGb: null } });
  assert.equal((await unknown.services.startPull({ repoId: "a/b", file: "x.safetensors", folder: "checkpoints" })).status, "running");
});

test("AC-FM-02: the pod's mismatch verdict fails the pull with both hashes, nothing is under models/, and the pull's staging + verdict keys are deleted", async () => {
  const f = fixture({ hub: fakeHub({ sha256: WANT }) });
  const pull = await f.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" });
  f.objects.set(`ytm-staging/${pull.pullId}/m.safetensors.partial`, 7); // litter of a pod that was killed mid-way
  f.verdicts.set(`ytm-pulls/${pull.pullId}.json`, JSON.stringify({ ok: false, sha256: OTHER, bytes: 1000 }));
  const [failed] = await f.services.pollPulls();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", new RegExp(`expected ${WANT}.*${OTHER}`));
  assert.equal(failed.actualSha256, OTHER);
  assert.ok(f.calls.includes("terminate:cpupod1"));
  assert.ok(f.calls.includes(`delete:ytm-staging/${pull.pullId}/m.safetensors.partial`));
  assert.ok(f.calls.includes(`delete:ytm-pulls/${pull.pullId}.json`));
  assert.deepEqual(await f.services.listModels(), []);
  assert.equal(await f.services.hasActivePull(), false);
});

test("AC-FM-02: a matching verdict with the file at the final key ends done with the measured hash and size; the model is listed", async () => {
  const f = fixture({ hub: fakeHub({ sha256: WANT }) });
  const pull = await f.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" });
  f.objects.set("models/checkpoints/m.safetensors", 1000);
  f.verdicts.set(`ytm-pulls/${pull.pullId}.json`, JSON.stringify({ ok: true, sha256: WANT, bytes: 1000 }));
  const [done] = await f.services.pollPulls();
  assert.equal(done.status, "done");
  assert.equal(done.actualSha256, WANT);
  assert.equal(done.bytes, 1000);
  assert.deepEqual((await f.services.listModels()).map((m) => m.key), ["models/checkpoints/m.safetensors"]);
});

test("AC-FM-03: a file at the final key WITHOUT the pod's verdict is not done; a verdict whose size S3 does not show yet waits; a verdict file that is not JSON fails the pull", async () => {
  const noVerdict = fixture({ hub: fakeHub({ sha256: WANT }), podWritesVerdict: false });
  await noVerdict.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" });
  noVerdict.objects.set("models/checkpoints/m.safetensors", 1000);
  assert.equal((await noVerdict.services.pollPulls())[0].status, "running");

  const lag = fixture({ hub: fakeHub({ sha256: WANT }) });
  const pull = await lag.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" });
  lag.verdicts.set(`ytm-pulls/${pull.pullId}.json`, JSON.stringify({ ok: true, sha256: WANT, bytes: 1000 }));
  assert.equal((await lag.services.pollPulls())[0].status, "running", "S3 does not show the file yet");
  lag.objects.set("models/checkpoints/m.safetensors", 1000);
  assert.equal((await lag.services.pollPulls())[0].status, "done");

  const garbled = fixture({ hub: fakeHub({ sha256: WANT }) });
  const g = await garbled.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" });
  garbled.verdicts.set(`ytm-pulls/${g.pullId}.json`, "{ not json");
  const [failed] = await garbled.services.pollPulls();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /verdict/);
});

test("BL-132: the pull downloads the commit the Hub resolved the revision to, and records revision, commit, expected size and who asked", async () => {
  const f = fixture({ hub: fakeHub({ sha256: WANT, commitSha: "deadbeef", bytes: 4242 }) });
  const pull = await f.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "loras", revision: "v1.0" }, { requestedBy: "factory" });
  assert.deepEqual([pull.revision, pull.commitSha, pull.expectedBytes, pull.requestedBy], ["v1.0", "deadbeef", 4242, "factory"]);
  assert.ok(f.calls.some((c) => c.includes("--revision 'deadbeef'")));
  await assert.rejects(f.services.startPull({ repoId: "a/b", file: "x", folder: "vae", revision: "../etc" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(f.services.startPull({ repoId: "a/b", file: "x", folder: "vae", sha256: "abc" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("AC-FM-14: start, finish, cancel and delete are audited with the actor (factory or owner)", async () => {
  const f = fixture({ hub: fakeHub({ sha256: WANT }) });
  const first = await f.services.startPull({ repoId: "a/b", file: "m.safetensors", folder: "checkpoints" }, { requestedBy: "factory" });
  f.objects.set("models/checkpoints/m.safetensors", 1000);
  await f.services.pollPulls();
  await f.services.deleteModel({ key: "models/checkpoints/m.safetensors" }, { actor: "factory" });
  const second = await f.services.startPull({ repoId: "a/b", file: "n.safetensors", folder: "vae" });
  await f.services.cancelPull({ pullId: second.pullId }, { actor: "owner" });
  assert.deepEqual(
    f.events.map((e) => [e.actor, e.action, e.subject]),
    [
      ["factory", "model_pull_started", "models/checkpoints/m.safetensors"],
      ["factory", "model_pull_done", "models/checkpoints/m.safetensors"],
      ["factory", "model_deleted", "models/checkpoints/m.safetensors"],
      ["owner", "model_pull_started", "models/vae/n.safetensors"],
      ["owner", "model_pull_cancelled", "models/vae/n.safetensors"],
    ]
  );
  assert.equal(f.events[1].details?.actualSha256, WANT);
  assert.equal(f.events[0].details?.pullId, first.pullId);
});
