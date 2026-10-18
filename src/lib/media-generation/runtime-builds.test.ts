import assert from "node:assert/strict";
import test from "node:test";
import type { CreatePodInput, RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSettings } from "./contracts";
import type { MediaControlEvent } from "./models";
import { buildPodNameFor, createRuntimeBuildServices, templateImageOf } from "./runtime-builds";
import { runtimeKey } from "./runtimes";

// BL-200 stage 2 (POD_RUNTIMES_PLAN.md §3, AC-RT-03; ADR 0043): a profile is built on a CPU pod with the GPU template's image
// and the command `runtime-build.sh <id>`; build.json ok (with .ready) -> built, ok:false -> build_failed with its error; the
// pod is terminated in both cases; no .ready means not built. The pod gets no secret and no port.

const IMAGE = "runpod/comfyui:1.4.0-comfyuiv0.35.0-cuda12.8";
const RID = "comfy-0410-flux3";
const SETTINGS: Partial<MediaSettings> = { datacenterId: "EU-RO-1", networkVolumeId: "vol1", templateId: "tpl1", gpuTypeId: "NVIDIA GeForce RTX 4090", gpuFallbackIds: ["NVIDIA RTX A5000", "NVIDIA L40S"] };
const gpu = (id: string, price: number) => ({ id, displayName: id, memoryInGb: 24, secureCloud: true, communityCloud: false, onDemandPricePerHr: price, spotPricePerHr: null, estimatedAvailability: "High", dataCenters: [{ id: "EU-RO-1", countryCode: "RO", estimatedAvailability: "High" }], cudaVersions: [] });

function harness(options: { settings?: Partial<MediaSettings>; templateRaw?: Record<string, unknown>; scripts?: Record<string, string>; noCapacity?: string[] } = {}) {
  let now = new Date("2026-10-18T15:00:00Z");
  const objects = new Map<string, string>();
  objects.set(runtimeKey(RID, "runtime.json"), "{}");
  const events: MediaControlEvent[] = [];
  const created: CreatePodInput[] = [];
  const pods = new Map<string, { id: string; name: string; status: string }>();
  const terminated: string[] = [];
  let jobsJson: string | null = null;
  const s3 = {
    async getObjectText(key: string) {
      return objects.get(key) ?? null;
    },
    async headObject(key: string) {
      return objects.has(key) ? { size: objects.get(key)!.length, etag: null, lastModified: null } : null;
    },
    async putObject(key: string, body: string | Uint8Array) {
      objects.set(key, String(body));
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
  } as unknown as RunpodS3Client;
  const client = {
    async listTemplates() {
      return [{ id: "tpl1", name: "ytm-comfyui-v2", raw: options.templateRaw ?? { id: "tpl1", imageName: IMAGE } }];
    },
    async listGpuTypes() {
      return [gpu("NVIDIA GeForce RTX 4090", 0.89), gpu("NVIDIA RTX A5000", 0.29), gpu("NVIDIA L40S", 1.19)];
    },
    async createPod(input: CreatePodInput) {
      created.push(input);
      if (options.noCapacity?.includes(input.gpu?.id ?? "")) {
        const { DomainError } = await import("./contracts");
        throw new DomainError({ code: "runpod_api_unavailable", message: "RunPod API returned HTTP 400: This GPU and data center combination could not be placed.", details: { status: 400 } });
      }
      const pod = { id: `pod${created.length}`, name: input.name, status: "RUNNING" };
      pods.set(pod.id, pod);
      return pod;
    },
    async getPod(id: string) {
      return pods.get(id) ?? null;
    },
    async terminatePod(id: string) {
      terminated.push(id);
      const pod = pods.get(id);
      if (pod) pod.status = "TERMINATED";
      return { alreadyGone: !pod };
    },
    async listPods() {
      return [...pods.values()];
    },
  } as unknown as RunpodApiClient;
  const scripts = options.scripts ?? { "pod-start.sh": "#!/bin/bash start v2", "runtime-build.sh": "#!/bin/bash build v1" };
  const services = createRuntimeBuildServices({
    store: {
      getJobsJson: async () => jobsJson,
      updateJobsJson: async (mutate) => (jobsJson = mutate(jobsJson)),
    },
    base: { getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, ...SETTINGS, ...options.settings }), resolveRunpodClient: async () => client, s3: async () => s3 },
    readPodScript: async (name) => scripts[name],
    events: { record: async (e) => void events.push(e) },
    generateId: () => "abcdef12-0000-0000-0000-000000000000",
    clock: { now: () => now },
    sleep: async () => undefined,
  });
  return { services, objects, events, created, pods, terminated, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

// Probe 2 (2026-10-18, owner msg 3035): a CPU host never started the CUDA image, so the build pod is the CHEAPEST GPU of the owner's
// list in the volume's datacenter (the next one on no capacity). The rest of AC-RT-03 is unchanged.
test("AC-RT-03: the build pod is the cheapest GPU of the owner's list with the template's image, the volume, and the command runtime-build.sh <id> -- no secret, no port", async () => {
  const h = harness();
  const { job, alreadyBuilt } = await h.services.startRuntimeBuild({ runtimeId: RID }, { actor: "factory" });
  assert.equal(alreadyBuilt, false);
  assert.equal(h.created.length, 1);
  const pod = h.created[0];
  assert.equal(pod.image, IMAGE);
  assert.equal(pod.templateId, undefined);
  assert.deepEqual(pod.gpu, { id: "NVIDIA RTX A5000", count: 1 }, "$0.29/h is the cheapest of the list");
  assert.equal(pod.cpu, undefined);
  assert.equal(job?.gpuTypeId, "NVIDIA RTX A5000");
  assert.deepEqual(pod.entrypoint, ["bash", "/workspace/ytm/runtime-build.sh", RID]);
  assert.deepEqual(pod.mounts, { network: [{ volumeId: "vol1", path: "/workspace" }] });
  assert.equal(pod.dataCenterId, "EU-RO-1");
  assert.equal(pod.env, undefined);
  assert.equal(pod.ports, undefined);
  assert.equal(pod.name, buildPodNameFor("abcdef12"));
  assert.equal(job?.status, "running");
  assert.equal(job?.requestedBy, "factory");
  assert.ok(h.events.some((e) => e.action === "runtime_build_started" && e.subject === RID && e.actor === "factory"));
});

test("AC-RT-03: build.json ok with .ready -> built, pod terminated", async () => {
  const h = harness();
  await h.services.startRuntimeBuild({ runtimeId: RID });
  await h.services.pollRuntimeBuilds();
  assert.deepEqual(h.terminated, [], "nothing to do before build.json");
  h.objects.set(`ytm/runtimes/${RID}/.ready`, "");
  h.objects.set(runtimeKey(RID, "build.json"), JSON.stringify({ ok: true, seconds: 540, error: null, finishedAt: "2026-10-18T15:09:00Z" }));
  const [job] = await h.services.pollRuntimeBuilds();
  assert.equal(job.status, "built");
  assert.equal(job.seconds, 540);
  assert.deepEqual(h.terminated, ["pod1"]);
  assert.ok(h.events.some((e) => e.action === "runtime_built"));
});

test("AC-RT-03: build.json ok:false -> failed with the pod's error, pod terminated, the lock file removed", async () => {
  const h = harness();
  await h.services.startRuntimeBuild({ runtimeId: RID });
  h.objects.set(`ytm/runtimes/${RID}/.lock`, "pod1");
  h.objects.set(runtimeKey(RID, "build.json"), JSON.stringify({ ok: false, seconds: 30, error: "pip install failed (see build.log)" }));
  const [job] = await h.services.pollRuntimeBuilds();
  assert.equal(job.status, "failed");
  assert.equal(job.error, "pip install failed (see build.log)");
  assert.deepEqual(h.terminated, ["pod1"]);
  assert.equal(h.objects.has(`ytm/runtimes/${RID}/.lock`), false);
  assert.ok(h.events.some((e) => e.action === "runtime_build_failed"));
});

test("AC-RT-03: an ok verdict without .ready is not a built runtime", async () => {
  const h = harness();
  await h.services.startRuntimeBuild({ runtimeId: RID });
  h.objects.set(runtimeKey(RID, "build.json"), JSON.stringify({ ok: true, seconds: 10 }));
  const [job] = await h.services.pollRuntimeBuilds();
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /\.ready/);
});

test("a build pod that dies before build.json fails the build at once (not at the cap); past the cap a silent build times out and is terminated", async () => {
  const dead = harness();
  await dead.services.startRuntimeBuild({ runtimeId: RID });
  dead.pods.get("pod1")!.status = "EXITED";
  const [failed] = await dead.services.pollRuntimeBuilds();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /EXITED before it wrote build\.json/);

  const silent = harness();
  await silent.services.startRuntimeBuild({ runtimeId: RID });
  silent.advance(29 * 60_000); // the cap is 30 min since probe 2 (a GPU-priced build pod)
  assert.equal((await silent.services.pollRuntimeBuilds())[0].status, "running");
  silent.advance(2 * 60_000);
  const [timedOut] = await silent.services.pollRuntimeBuilds();
  assert.equal(timedOut.status, "timeout");
  assert.deepEqual(silent.terminated, ["pod1"]);
});

test("a built profile (.ready present) starts no pod; a second build of a profile being built is refused; an unknown profile is not_found", async () => {
  const h = harness();
  h.objects.set(`ytm/runtimes/${RID}/.ready`, "");
  assert.deepEqual(await h.services.startRuntimeBuild({ runtimeId: RID }), { job: null, alreadyBuilt: true });
  assert.equal(h.created.length, 0);

  const busy = harness();
  await busy.services.startRuntimeBuild({ runtimeId: RID });
  await assert.rejects(busy.services.startRuntimeBuild({ runtimeId: RID }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  assert.equal(busy.created.length, 1);

  await assert.rejects(h.services.startRuntimeBuild({ runtimeId: "no-such-runtime" }), (e: unknown) => isDomainError(e) && e.code === "not_found");
});

test("a template with no image, or no template / volume configured, is refused before any pod (never a fallback image)", async () => {
  const noImage = harness({ templateRaw: { id: "tpl1" } });
  await assert.rejects(noImage.services.startRuntimeBuild({ runtimeId: RID }), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.equal(noImage.created.length, 0);
  const noTemplate = harness({ settings: { templateId: null } });
  await assert.rejects(noTemplate.services.startRuntimeBuild({ runtimeId: RID }), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.equal(noTemplate.created.length, 0);
  assert.equal(templateImageOf({ imageName: " img:1 " }), "img:1");
  assert.equal(templateImageOf({ image: "img:2" }), "img:2");
});

test("the pod-side scripts are uploaded only when the volume's copy differs", async () => {
  const h = harness();
  h.objects.set("ytm/pod-start.sh", "#!/bin/bash start v2");
  h.objects.set("ytm/runtime-build.sh", "#!/bin/bash build v0");
  assert.deepEqual(await h.services.ensurePodScripts(), { uploaded: ["runtime-build.sh"] });
  assert.equal(h.objects.get("ytm/runtime-build.sh"), "#!/bin/bash build v1");
  assert.deepEqual(await h.services.ensurePodScripts(), { uploaded: [] });
});

// Review findings (AC-RT-03 "build.json ok:false gives build_failed" is about THIS build's verdict, never an earlier one's).
test("a rebuild after a failed build is not failed by the old build.json: it is removed before the new pod, and a verdict older than the build is ignored", async () => {
  const h = harness();
  h.objects.set(runtimeKey(RID, "build.json"), JSON.stringify({ ok: false, seconds: 30, error: "old failure", finishedAt: "2026-10-18T14:00:00Z" }));
  await h.services.startRuntimeBuild({ runtimeId: RID });
  assert.equal(h.objects.has(runtimeKey(RID, "build.json")), false, "the old verdict is gone before the pod");
  // S3 lagging: the old verdict is still read once -- it predates the build and is not its answer.
  h.objects.set(runtimeKey(RID, "build.json"), JSON.stringify({ ok: false, seconds: 30, error: "old failure", finishedAt: "2026-10-18T14:00:00Z" }));
  const [job] = await h.services.pollRuntimeBuilds();
  assert.equal(job.status, "running");
  assert.deepEqual(h.terminated, []);
});

test("an ended build removes only its own lock file: another pod's lock (another computer's build) stays", async () => {
  const h = harness();
  await h.services.startRuntimeBuild({ runtimeId: RID });
  h.objects.set(`ytm/runtimes/${RID}/.lock`, "other-pod\n");
  h.pods.get("pod1")!.status = "EXITED"; // the loser of the lock exits
  const [job] = await h.services.pollRuntimeBuilds();
  assert.equal(job.status, "failed");
  assert.equal(h.objects.get(`ytm/runtimes/${RID}/.lock`), "other-pod\n");
});

test("probe 2: no capacity on the cheapest GPU moves the build to the next cheapest; none at all fails the build with no pod", async () => {
  const h = harness({ noCapacity: ["NVIDIA RTX A5000"] });
  const { job } = await h.services.startRuntimeBuild({ runtimeId: RID });
  assert.deepEqual(h.created.map((c) => c.gpu?.id), ["NVIDIA RTX A5000", "NVIDIA GeForce RTX 4090"]);
  assert.equal(job?.gpuTypeId, "NVIDIA GeForce RTX 4090");
  const none = harness({ noCapacity: ["NVIDIA RTX A5000", "NVIDIA GeForce RTX 4090", "NVIDIA L40S"] });
  await assert.rejects(none.services.startRuntimeBuild({ runtimeId: RID }), (e: unknown) => isDomainError(e) && e.code === "media_no_capacity");
  assert.equal(none.pods.size, 0);
  assert.equal((await none.services.listRuntimeBuilds())[0].status, "failed");
});
