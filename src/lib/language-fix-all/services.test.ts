import assert from "node:assert/strict";
import test from "node:test";
import { createOperationRegistry, OperationAlreadyRunningError } from "@/lib/operation-progress";
import { DomainError } from "./contracts";
import { createLanguageFixAllServices, type FixAllDependencies } from "./services";

// Acceptance criteria (owner instruction 2026-10-03 + AGENTS.md §F/§G), written from the
// requirement rather than from the implementation:
//  AC-1 the server -- not the caller -- decides which fields/values are written: only the baseline
//       value of a field that actually deviates, never anything else;
//  AC-2 a video that is not in the channel's deviation report is never sent;
//  AC-3 every write goes through applyFieldsUpdate with the channel as expectedChannelId and the
//       previewed etag as expectedEtag;
//  AC-4 fail-fast: after the first failure (or unverified read-back) no further write is made;
//  AC-5 cancel is honoured before the next video; nothing after it is written;
//  AC-6 one active run per channel;
//  AC-7 bad input / no baseline is rejected before anything is registered or written.

type Call = Parameters<FixAllDependencies["applyFieldsUpdate"]>[0];

function setup(opts: {
  defaults?: { defaultLanguage: string | null; defaultAudioLanguage: string | null };
  deviations?: Array<{ videoId: string; title?: string; lang?: boolean; audio?: boolean }>;
  apply?: (call: Call, index: number) => Promise<{ verified: boolean }>;
  assertMutationAllowed?: () => Promise<void>;
  quotaGuard?: FixAllDependencies["quotaGuard"];
} = {}) {
  const calls: Call[] = [];
  const registry = createOperationRegistry();
  const deviations = opts.deviations ?? [
    { videoId: "v1", lang: true, audio: true },
    { videoId: "v2", lang: true, audio: false },
    { videoId: "v3", lang: false, audio: true },
  ];
  const service = createLanguageFixAllServices({
    registry,
    assertMutationAllowed: opts.assertMutationAllowed ?? (async () => undefined),
    quotaGuard: opts.quotaGuard,
    getDeviations: async () => ({
      defaults: opts.defaults ?? { defaultLanguage: "en", defaultAudioLanguage: "ja" },
      deviations: deviations.map((d) => ({
        videoId: d.videoId,
        title: d.title ?? `Title ${d.videoId}`,
        defaultLanguageDeviates: d.lang ?? false,
        defaultAudioLanguageDeviates: d.audio ?? false,
      })),
    }),
    applyFieldsUpdate: async (call) => {
      calls.push(call);
      return opts.apply ? opts.apply(call, calls.length - 1) : { verified: true };
    },
  });
  return { service, calls, registry };
}

const BASELINE = { defaultLanguage: "en", defaultAudioLanguage: "ja" };

const request = (
  ids: string[],
  baseline: { defaultLanguage: string | null; defaultAudioLanguage: string | null } = BASELINE
) => ({
  channelId: "UC1",
  userId: "user-1",
  baseline,
  videos: ids.map((videoId) => ({ videoId, expectedEtag: `etag-${videoId}` })),
});

test("AC-1: patch contains only the deviating fields, with the baseline values", async () => {
  const { service, calls } = setup();
  const { run } = await service.start(request(["v1", "v2", "v3"]));
  await run();
  assert.deepEqual(
    calls.map((c) => [c.videoId, c.patch]),
    [
      ["v1", { defaultLanguage: "en", defaultAudioLanguage: "ja" }],
      ["v2", { defaultLanguage: "en" }],
      ["v3", { defaultAudioLanguage: "ja" }],
    ]
  );
});

test("AC-1: a caller-supplied patch or value is rejected as invalid input, never forwarded", async () => {
  const { service, calls } = setup();
  await assert.rejects(() =>
    service.start({ channelId: "UC1", userId: "u", baseline: BASELINE, videos: [{ videoId: "v1", patch: { title: "Hacked" } }] })
  );
  assert.equal(calls.length, 0);
});

test("AC-1: a baseline with only one field set never writes the other", async () => {
  const { service, calls } = setup({ defaults: { defaultLanguage: "en", defaultAudioLanguage: null } });
  const { run } = await service.start(request(["v1", "v3"], { defaultLanguage: "en", defaultAudioLanguage: null }));
  await run();
  // v3 deviates only in audio, which has no baseline -> nothing to change -> not sent.
  assert.deepEqual(calls.map((c) => [c.videoId, c.patch]), [["v1", { defaultLanguage: "en" }]]);
});

test("AC-2: a video outside the deviation report is skipped and never sent", async () => {
  const { service, calls, registry } = setup();
  const { operationId, run } = await service.start(request(["v1", "not-mine"]));
  await run();
  assert.deepEqual(calls.map((c) => c.videoId), ["v1"]);
  const snap = registry.get(operationId)!;
  assert.equal(snap.items.find((i) => i.id === "not-mine")!.status, "skipped");
  assert.equal(snap.status, "success");
});

test("AC-3: channel, user and previewed etag are passed to the apply call", async () => {
  const { service, calls } = setup();
  const { run } = await service.start(request(["v2"]));
  await run();
  assert.deepEqual(calls[0], {
    credentialRef: { userId: "user-1" },
    expectedChannelId: "UC1",
    videoId: "v2",
    patch: { defaultLanguage: "en" },
    expectedEtag: "etag-v2",
  });
});

test("AC-3: no etag supplied -> none is invented", async () => {
  const { service, calls } = setup();
  const { run } = await service.start({ channelId: "UC1", userId: "u", baseline: BASELINE, videos: [{ videoId: "v2" }] });
  await run();
  assert.equal("expectedEtag" in calls[0], false);
});

test("AC-4: first thrown error stops the run; remaining videos are skipped and not written", async () => {
  const { service, calls, registry } = setup({
    apply: async (_call, index) => {
      if (index === 1) throw new Error("etag conflict");
      return { verified: true };
    },
  });
  const { operationId, run } = await service.start(request(["v1", "v2", "v3"]));
  await run();
  assert.deepEqual(calls.map((c) => c.videoId), ["v1", "v2"]);
  const snap = registry.get(operationId)!;
  assert.equal(snap.status, "failed");
  assert.deepEqual(snap.items.map((i) => i.status), ["done", "failed", "skipped"]);
  assert.equal(snap.items[1].detail, "etag conflict");
  assert.match(snap.message ?? "", /Stopped at the first error: etag conflict/);
});

test("AC-4: an unverified read-back counts as a failure and stops the run", async () => {
  const { service, calls, registry } = setup({ apply: async () => ({ verified: false }) });
  const { operationId, run } = await service.start(request(["v1", "v2"]));
  await run();
  assert.equal(calls.length, 1);
  assert.equal(registry.get(operationId)!.status, "failed");
});

test("AC-5: cancel requested during a video -> that one completes, the next is not written, status cancelled", async () => {
  const holder: { registry?: ReturnType<typeof createOperationRegistry> } = {};
  let opId = "";
  const { service, calls, registry } = setup({
    apply: async (_call, index) => {
      if (index === 0) holder.registry?.requestCancel(opId);
      return { verified: true };
    },
  });
  holder.registry = registry;
  const started = await service.start(request(["v1", "v2", "v3"]));
  opId = started.operationId;
  await started.run();
  assert.deepEqual(calls.map((c) => c.videoId), ["v1"]);
  const snap = registry.get(opId)!;
  assert.equal(snap.status, "cancelled");
  assert.deepEqual(snap.items.map((i) => i.status), ["done", "skipped", "skipped"]);
});

test("AC-6: a second Fix all for the same channel is refused while the first is active; allowed after it ends", async () => {
  const { service } = setup();
  const first = await service.start(request(["v1"]));
  await assert.rejects(() => service.start(request(["v2"])), OperationAlreadyRunningError);
  await first.run();
  await service.start(request(["v2"]));
});

test("AC-7: no videos, too many videos, missing baseline and nothing-to-change are rejected before anything is registered", async () => {
  const { service, calls, registry } = setup({ defaults: { defaultLanguage: null, defaultAudioLanguage: null } });
  await assert.rejects(() => service.start(request([])), /Invalid Fix all request/);
  await assert.rejects(() => service.start(request(Array.from({ length: 501 }, (_, i) => `v${i}`))), /Invalid Fix all request/);
  await assert.rejects(() => service.start(request(["v1"], { defaultLanguage: null, defaultAudioLanguage: null })), /no language baseline/);
  const none = setup();
  await assert.rejects(() => none.service.start(request(["unknown"])), /None of the requested videos/);
  assert.equal(calls.length, 0);
  assert.equal(registry.list({ channelId: "UC1" }).length, 0);
  assert.equal(none.registry.list({ channelId: "UC1" }).length, 0);
});

test("duplicate video ids in the request are written once", async () => {
  const { service, calls } = setup();
  const { run } = await service.start(request(["v1", "v1"]));
  await run();
  assert.equal(calls.length, 1);
});

test("run never throws: an unexpected failure ends the operation as failed", async () => {
  const { service, registry } = setup({
    apply: async () => {
      throw Object.assign(new Error("db gone"), {});
    },
  });
  const { operationId, run } = await service.start(request(["v1"]));
  await run();
  assert.equal(registry.get(operationId)!.status, "failed");
});

// AC-8 (approval integrity, AGENTS.md section G): the operator approved a diff against the baseline
// shown at preview time. If the channel baseline was changed afterwards (another tab, another
// session), the server must NOT write the new value the operator never saw.
test("AC-8: the baseline the operator previewed must equal the current one, else nothing is registered or written", async () => {
  const { service, calls, registry } = setup(); // current baseline: en / ja
  await assert.rejects(
    () => service.start(request(["v1"], { defaultLanguage: "de", defaultAudioLanguage: "ja" })),
    (e: unknown) => (e as { code?: string }).code === "video_details_conflict" && /re-run the check|changed/i.test((e as Error).message)
  );
  await assert.rejects(
    () => service.start(request(["v1"], { defaultLanguage: "en", defaultAudioLanguage: null })),
    (e: unknown) => (e as { code?: string }).code === "video_details_conflict"
  );
  assert.equal(calls.length, 0);
  assert.equal(registry.list({ channelId: "UC1" }).length, 0);
});

test("AC-8: a request without a baseline is rejected as invalid input", async () => {
  const { service, calls } = setup();
  await assert.rejects(() => service.start({ channelId: "UC1", userId: "u", videos: [{ videoId: "v1" }] }), /Invalid Fix all request/);
  assert.equal(calls.length, 0);
});

// AC-9 (mutation gate): the proxy gates only the START request. A device-handoff export/import or an
// unavailable device appearing mid-run must stop the remaining writes, exactly as it did when every
// video was its own gated POST.
test("AC-9: the mutation gate is checked before EVERY video; a refusal stops the run before that write", async () => {
  let gateCalls = 0;
  const { service, calls, registry } = setup({
    assertMutationAllowed: async () => {
      gateCalls += 1;
      if (gateCalls === 2) throw new Error("An export is running");
    },
  });
  const { operationId, run } = await service.start(request(["v1", "v2", "v3"]));
  await run();
  assert.equal(gateCalls, 2);
  assert.deepEqual(calls.map((c) => c.videoId), ["v1"]); // v2 refused by the gate, v3 never tried
  const snap = registry.get(operationId)!;
  assert.equal(snap.status, "failed");
  assert.deepEqual(snap.items.map((i) => i.status), ["done", "failed", "skipped"]);
  assert.match(snap.items[1].detail ?? "", /An export is running/);
});

test("AC-9: a gate that refuses from the start writes nothing", async () => {
  const { service, calls } = setup({ assertMutationAllowed: async () => Promise.reject(new Error("device unavailable")) });
  const { run } = await service.start(request(["v1", "v2"]));
  await run();
  assert.equal(calls.length, 0);
});

// BL-117 slice 2 (owner decision 2026-10-03: Fix all gets the same pre-flight quota block as Batches). Acceptance criteria:
//  AC-G11 a run that certainly needs more quota than is left is refused BEFORE it is registered or anything is written, with the
//         numbers and how many videos would fit; an unreadable quota is its own refusal that the user may knowingly override;
//         only the videos that will really be written count (skipped ones cost nothing).
type FixAllVerdict = NonNullable<FixAllDependencies["quotaGuard"]> extends { checkWriteRun(n: number): Promise<infer V> } ? V : never;

function guard(verdict: FixAllVerdict) {
  const asked: number[] = [];
  return {
    asked,
    quotaGuard: {
      async checkWriteRun(videos: number) {
        asked.push(videos);
        return verdict;
      },
    },
  };
}

test("BL-117 AC-G11: insufficient quota refuses Fix all before anything is registered or written; only videos to be written are counted", async () => {
  const { asked, quotaGuard } = guard({ decision: "insufficient", estimatedUnits: 104, remainingUnits: 60, fitVideos: 1, resetsAt: "2026-10-04T07:00:00.000Z" });
  const { service, calls, registry } = setup({ quotaGuard });
  await assert.rejects(
    service.start(request(["v1", "v2", "v3", "not-a-deviation"])),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "quota_insufficient");
      assert.deepEqual(error.details, { estimatedUnits: 104, remainingUnits: 60, rowsToWrite: 3, fitVideos: 1, resetsAt: "2026-10-04T07:00:00.000Z", canSplit: false });
      return true;
    }
  );
  assert.deepEqual(asked, [3], "the video that is not in the deviation report costs nothing and is not counted");
  assert.equal(calls.length, 0);
  assert.equal(registry.hasActive(), false, "nothing was registered");
});

test("BL-117: an allowed verdict runs Fix all normally", async () => {
  const { quotaGuard } = guard({ decision: "allow", estimatedUnits: 156, remainingUnits: 500, fitVideos: 9 });
  const { service, calls } = setup({ quotaGuard });
  const { run } = await service.start(request(["v1", "v2", "v3"]));
  await run();
  assert.equal(calls.length, 3);
});

test("BL-117 AC-G4 (Fix all): an unreadable quota refuses with quota_unknown, unless the user acknowledges; nothing is started by the refusal", async () => {
  const { quotaGuard } = guard({ decision: "unknown", estimatedUnits: 156, cloudConnected: false });
  const first = setup({ quotaGuard });
  await assert.rejects(
    first.service.start(request(["v1", "v2", "v3"])),
    (error: unknown) => error instanceof DomainError && error.code === "quota_unknown" && (error.details as { cloudConnected: boolean }).cloudConnected === false
  );
  assert.equal(first.calls.length, 0);
  assert.equal(first.registry.hasActive(), false);

  const second = setup({ quotaGuard });
  const { run } = await second.service.start({ ...request(["v1", "v2", "v3"]), acknowledgeUnknownQuota: true });
  await run();
  assert.equal(second.calls.length, 3);
});
