import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodApiClient, RunpodS3Client, S3ObjectSummary } from "@/lib/media-gateway";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { DEFAULT_MEDIA_SETTINGS, type MediaSettings } from "./contracts";
import { createVolumeMigrationServices, pickProbeObjects } from "./volume-migration";

// BL-136 step 0 (docs/roadmap/plans/VOLUME_MIGRATION_PLAN.md): the probe creates a 20 GB test volume, copies the smallest file
// and the largest file of 0.5-18 GB from the current volume into it over S3 CopyObject, checks sizes, and ALWAYS deletes the test
// volume. Both copies matching = server-side copy works (variant A); a failed copy = pods + rsync (variant B).

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const obj = (key: string, size: number): S3ObjectSummary => ({ key, size, lastModified: null, etag: null });

test("pickProbeObjects: the smallest non-empty file, and the largest file between 500 MB and 18 GB", () => {
  const picked = pickProbeObjects([
    obj("models/vae/.keep", 0),
    obj("ytm-pulls/p1.json", 300),
    obj("models/vae/ace.safetensors", 322 * MB),
    obj("models/checkpoints/sa3.safetensors", 8.6 * GB),
    obj("models/checkpoints/huge.safetensors", 19 * GB), // over 18 GB: does not fit the 20 GB probe volume with room
    obj("models/te/t5.safetensors", 1.1 * GB),
    obj(".s3compat_uploads/x/part1", 100), // RunPod's multipart staging, never copied
  ]);
  assert.equal(picked.small?.key, "ytm-pulls/p1.json");
  assert.equal(picked.large?.key, "models/checkpoints/sa3.safetensors");
  assert.deepEqual(pickProbeObjects([obj("a/.keep", 0)]), { small: null, large: null });
});

function fixture(
  opts: { objects?: S3ObjectSummary[]; copyFails?: (key: string) => string | null; copiedSize?: (key: string, size: number) => number; unreachable?: boolean; deleteFails?: boolean; pods?: Array<{ id: string; networkVolumeIds: string[]; dataCenterId?: string | null; raw?: Record<string, unknown> }>; createFailsAfterCreating?: boolean; copyTimesOut?: boolean; switchSettingsTo?: string } = {}
) {
  const calls: string[] = [];
  const objects = opts.objects ?? [obj("ytm-pulls/p1.json", 300), obj("models/te/t5.safetensors", 1.1 * GB)];
  const sizes = new Map(objects.map((o) => [o.key, o.size]));
  const copied = new Map<string, number>();
  const settings: MediaSettings = { ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", networkVolumeId: "src-vol" };
  const runpod = {
    async createNetworkVolume(input: { name: string; dataCenterId: string; sizeGb: number }) {
      calls.push(`create:${input.dataCenterId}:${input.sizeGb}`);
      if (opts.createFailsAfterCreating) throw new Error("timeout");
      return { id: "probe-vol", name: input.name, dataCenterId: input.dataCenterId, sizeGb: input.sizeGb, usedSizeGb: null, createdAt: null };
    },
    async listNetworkVolumes() {
      calls.push("listVolumes");
      return [{ id: "probe-vol", name: "ytm-copy-probe-20261006T1200", dataCenterId: "EU-RO-1", sizeGb: 20, usedSizeGb: null, createdAt: null }];
    },
    async getNetworkVolume(id: string) {
      return id === "missing" ? null : { id, name: `n-${id}`, dataCenterId: "EU-RO-1", sizeGb: 50, usedSizeGb: null, createdAt: null };
    },
    async listPods() {
      calls.push("listPods");
      return (opts.pods ?? []).map((p) => ({ dataCenterId: null, raw: { mounts: { network: p.networkVolumeIds.map((volumeId) => ({ volumeId })) } }, ...p }));
    },
    async deleteNetworkVolume(id: string) {
      calls.push(`delete:${id}`);
      if (opts.deleteFails) throw new Error("RunPod 500");
      return { deleted: true as const, alreadyGone: false };
    },
  } as unknown as RunpodApiClient;
  const source = {
    async listAllObjects(prefix: string) {
      calls.push(`list-source:${prefix}`);
      return objects;
    },
  } as unknown as RunpodS3Client;
  const target = {
    async listObjects() {
      calls.push("reach");
      if (opts.unreachable) throw new Error("NoSuchBucket");
      return { objects: [], isTruncated: false, nextContinuationToken: null };
    },
    async copyObjectFrom(sourceVolumeId: string, sourceKey: string, destinationKey: string) {
      calls.push(`copy:${sourceVolumeId}/${sourceKey}->${destinationKey}`);
      if (opts.copyTimesOut && sourceKey.endsWith(".safetensors")) throw new DomainError({ code: "runpod_s3_unavailable", message: "RunPod S3 request failed: The operation was aborted due to timeout", details: { method: "PUT", host: "x" } });
      const failure = opts.copyFails?.(sourceKey);
      if (failure) throw new Error(failure);
      copied.set(destinationKey, opts.copiedSize ? opts.copiedSize(sourceKey, sizes.get(sourceKey)!) : sizes.get(sourceKey)!);
    },
    async headObject(key: string) {
      const size = copied.get(key);
      return size === undefined ? null : { size, etag: null, lastModified: null };
    },
  } as unknown as RunpodS3Client;
  let now = Date.parse("2026-10-06T12:00:00Z");
  const services = createVolumeMigrationServices({
    base: {
      getSettings: async () => {
        // switchSettingsTo: a concurrent Setup save lands after the delete's first settings read.
        const current = { ...settings };
        if (opts.switchSettingsTo && calls.includes("listPods")) current.networkVolumeId = opts.switchSettingsTo;
        return current;
      },
      resolveRunpodClient: async () => runpod,
      s3: async () => source,
      s3ForVolume: async (id) => {
        calls.push(`s3For:${id}`);
        return target;
      },
    },
    clock: { now: () => new Date(now) },
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { services, calls, settings };
}

test("both copies match in size: verdict server-side, and the test volume is deleted; the source volume is only listed", async () => {
  const f = fixture();
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.verdict, "server-side");
  assert.equal(report.testVolumeId, "probe-vol");
  assert.equal(report.small?.ok, true);
  assert.equal(report.large?.ok, true);
  assert.equal(report.testVolumeDeleted, true);
  assert.deepEqual(f.calls, [
    "list-source:",
    "create:EU-RO-1:20",
    "s3For:probe-vol",
    "reach",
    "copy:src-vol/ytm-pulls/p1.json->ytm-probe/ytm-pulls/p1.json",
    "copy:src-vol/models/te/t5.safetensors->ytm-probe/models/te/t5.safetensors",
    "delete:probe-vol",
  ]);
});

test("a cross-volume copy that RunPod refuses gives verdict pods, and the test volume is still deleted", async () => {
  const f = fixture({ copyFails: () => "RunPod S3 returned HTTP 404 (NoSuchBucket)" });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.verdict, "pods");
  assert.match(report.small?.error ?? "", /NoSuchBucket/);
  assert.equal(report.large, null); // no point copying 1 GB once the small copy failed
  assert.equal(report.testVolumeDeleted, true);
  assert.ok(f.calls.includes("delete:probe-vol"));
});

test("a large copy that comes out with a different size is a failure: verdict pods", async () => {
  const f = fixture({ copiedSize: (key, size) => (key.endsWith("t5.safetensors") ? size - 1 : size) });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.small?.ok, true);
  assert.equal(report.large?.ok, false);
  assert.equal(report.verdict, "pods");
  assert.equal(report.testVolumeDeleted, true);
});

test("with no large file only the small copy is tested: verdict inconclusive, with a note", async () => {
  const f = fixture({ objects: [obj("ytm-pulls/p1.json", 300)] });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.small?.ok, true);
  assert.equal(report.large, null);
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.notes.length, 1);
});

test("a test volume never reachable over S3: no copy, a note, and the volume is deleted", async () => {
  const f = fixture({ unreachable: true });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.reachableAfterMs, null);
  assert.equal(report.small, null);
  assert.equal(report.verdict, "inconclusive");
  assert.ok(!f.calls.some((c) => c.startsWith("copy:")));
  assert.equal(report.testVolumeDeleted, true);
});

test("a failed delete is reported with the volume id to delete by hand, never hidden", async () => {
  const f = fixture({ deleteFails: true });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.testVolumeDeleted, false);
  assert.match(report.deleteError ?? "", /probe-vol/);
});

test("without a configured volume, or with nothing on it, the probe refuses before creating anything", async () => {
  const f = fixture({ objects: [] });
  await assert.rejects(f.services.probeCrossVolumeCopy(), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.ok(!f.calls.some((c) => c.startsWith("create:")));
  const g = fixture();
  g.settings.networkVolumeId = null;
  await assert.rejects(g.services.probeCrossVolumeCopy(), (e: unknown) => isDomainError(e) && e.code === "media_generation_not_configured");
  assert.deepEqual(g.calls, []);
});

// BL-136 step 6 / failed-migration cleanup: deleting a volume is permanent, so it is refused for the configured volume, an
// unknown volume, and a volume any pod still has mounted (RunPod does not document deleting one under a pod).
test("deleteUnusedNetworkVolume deletes a volume that is neither configured nor mounted", async () => {
  const f = fixture();
  assert.deepEqual(await f.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" }), { deleted: "old-vol", alreadyGone: false });
  assert.deepEqual(f.calls, ["listPods", "delete:old-vol"]);
});

test("deleteUnusedNetworkVolume refuses the configured volume, an unknown one, a mounted one and a malformed input, deleting nothing", async () => {
  const f = fixture({ pods: [{ id: "pod1", networkVolumeIds: ["old-vol"] }] });
  await assert.rejects(f.services.deleteUnusedNetworkVolume({ volumeId: "src-vol" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(f.services.deleteUnusedNetworkVolume({ volumeId: "missing" }), (e: unknown) => isDomainError(e) && e.code === "not_found");
  await assert.rejects(f.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /pod1/.test(e.message));
  await assert.rejects(f.services.deleteUnusedNetworkVolume({}), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(f.services.deleteUnusedNetworkVolume({ volumeId: "old-vol", extra: 1 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.ok(!f.calls.some((c) => c.startsWith("delete:")));
});

// Independent review: the pod list's mount data has not been seen live, so the guard fails closed.
test("deleteUnusedNetworkVolume refuses when a pod's mounts cannot be read, accepts a flat networkVolumeId, and skips pods of another datacenter", async () => {
  const unknown = fixture({ pods: [{ id: "pod-x", networkVolumeIds: [], raw: {} }] });
  await assert.rejects(unknown.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /pod-x/.test(e.message));
  const flat = fixture({ pods: [{ id: "pod-f", networkVolumeIds: [], raw: { networkVolumeId: "old-vol" } }] });
  await assert.rejects(flat.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /pod-f/.test(e.message));
  const elsewhere = fixture({ pods: [{ id: "pod-us", networkVolumeIds: [], dataCenterId: "US-TX-3", raw: {} }] });
  assert.equal((await elsewhere.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" })).deleted, "old-vol");
  const otherVolume = fixture({ pods: [{ id: "pod-o", networkVolumeIds: ["src-vol"] }] });
  assert.equal((await otherVolume.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" })).deleted, "old-vol");
  assert.ok(!unknown.calls.includes("delete:old-vol") && !flat.calls.includes("delete:old-vol"));
});

test("deleteUnusedNetworkVolume re-reads the settings right before deleting: a volume that just became the configured one is kept", async () => {
  const f = fixture({ switchSettingsTo: "old-vol" });
  await assert.rejects(f.services.deleteUnusedNetworkVolume({ volumeId: "old-vol" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.ok(!f.calls.includes("delete:old-vol"));
});

test("a copy that only timed out (no HTTP answer) makes the probe inconclusive, not 'pods'", async () => {
  const f = fixture({ copyTimesOut: true });
  const report = await f.services.probeCrossVolumeCopy();
  assert.equal(report.small?.ok, true);
  assert.equal(report.large?.timedOut, true);
  assert.equal(report.verdict, "inconclusive");
  assert.equal(report.testVolumeDeleted, true);
});

test("a create that fails after RunPod made the volume: the volume is found by its name and deleted, and the probe fails", async () => {
  const f = fixture({ createFailsAfterCreating: true });
  await assert.rejects(f.services.probeCrossVolumeCopy(), (e: unknown) => isDomainError(e) && /probe-vol/.test(e.message));
  assert.ok(f.calls.includes("delete:probe-vol"));
});
