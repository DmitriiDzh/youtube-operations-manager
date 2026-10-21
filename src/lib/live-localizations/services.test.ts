import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { FreshLiveVideo, LiveLocalizationsWriterDependencies } from "./contracts";
import { createLiveLocalizationsWriter } from "./services";

// BL-207 stage 3 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2 stage 3, §3 AC-LL-01/02/03/08/09). Written before the writer;
// every expected value is by hand from the plan, PROJECT_SPEC §21 and AGENTS.md §G: identity → fresh read → default language →
// the set never holds it → backup → merge → Live writes immediately before the update → read-back → audit.

type Video = { snippet: FreshLiveVideo["snippet"]; localizations: FreshLiveVideo["localizations"] };

const baseVideo = (): Video => ({
  snippet: { title: "T", description: "D", defaultLanguage: "en", defaultAudioLanguage: "en-US", tags: ["jazz", "lofi"], categoryId: "10", channelId: "UC1", liveBroadcastContent: "live" },
  localizations: { en: { title: "T", description: "D" }, fr: { title: "Fo", description: "Fd" }, it: { title: "Io", description: "Id" } },
});

const SET = { de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd2" } };

function harness(opts: {
  video?: Video | null;
  /** What YouTube stores after the update (default: exactly the payload, with the default-language mirror). */
  afterWrite?: (payload: { snippet: Record<string, unknown>; localizations: Record<string, { title: string; description: string }> }, video: Video) => Video;
  /** Reads served before the video shows the fields step's values (stale reads). */
  staleReads?: number;
  liveWrites?: boolean;
  wrongChannel?: boolean;
  backupUnhealthy?: boolean;
} = {}) {
  const calls: string[] = [];
  const audit: Array<{ eventType: string; detail: Record<string, unknown> }> = [];
  const backups: Array<Record<string, unknown>> = [];
  const updates: Array<{ videoId: string; payload: { snippet: Record<string, unknown>; localizations: Record<string, { title: string; description: string }> } }> = [];
  let video: Video | null = opts.video === undefined ? baseVideo() : opts.video;
  let stale = opts.staleReads ?? 0;
  const deps: LiveLocalizationsWriterDependencies = {
    auth: { resolve: async () => ({ credentialRef: { userId: "u1" }, accessToken: "t", scopeSet: new Set() }) as never },
    writeContext: {
      assertWriteChannel: async ({ expectedChannelId }) => {
        calls.push("identity");
        if (opts.wrongChannel) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH" as never, message: `authorized channel is not ${expectedChannelId}` });
        return { expectedChannelId };
      },
    },
    youtube: {
      readFresh: async () => {
        calls.push("videos.list");
        if (!video) return null;
        if (stale > 0) {
          stale -= 1;
          return { ...structuredClone(video), snippet: { ...structuredClone(video.snippet), tags: ["old"] } };
        }
        return structuredClone(video);
      },
      assertLiveWritesAuthorized: async () => {
        calls.push("liveWrites");
        if (opts.liveWrites === false) throw new DomainError({ code: "live_writes_disabled", message: "Real YouTube write execution is disabled" });
      },
      update: async (_credentials, videoId, payload) => {
        calls.push("videos.update");
        updates.push({ videoId, payload: structuredClone(payload) });
        const current = video!;
        video = opts.afterWrite
          ? opts.afterWrite(payload, current)
          : {
              snippet: { ...current.snippet, ...(payload.snippet as Video["snippet"]) },
              localizations: { ...payload.localizations, [String(payload.snippet.defaultLanguage)]: { title: String(payload.snippet.title), description: String(payload.snippet.description) } },
            };
      },
    },
    backup: {
      checkInfrastructureHealth: async () => (opts.backupUnhealthy ? { healthy: false, error: "disk unreachable" } : { healthy: true }),
      captureBackup: async (args) => {
        calls.push("backup");
        backups.push(args as unknown as Record<string, unknown>);
        return { path: "/backups/x.json", capturedAt: "2026-10-21T10:00:00.000Z" };
      },
    },
    audit: { record: async ({ eventType, detail }) => void audit.push({ eventType, detail: detail as Record<string, unknown> }) },
    sleep: async () => void calls.push("sleep"),
    newId: () => "op1",
    readBack: { attempts: 3, delayMs: 10 },
  };
  const writer = createLiveLocalizationsWriter(deps);
  return {
    calls,
    audit,
    backups,
    updates,
    video: () => video,
    apply: (localizations: Record<string, { title: string; description: string }> = SET, expected: Record<string, unknown> = {}) =>
      writer.apply({ credentialRef: { userId: "u1" }, channelId: "UC1", videoId: "BC1", localizations, expected }),
  };
}

test("AC-LL-01: one update keeps it, overwrites fr, adds de, leaves the snippet text, and keeps the audio language just read", async () => {
  const h = harness();
  const result = await h.apply();
  assert.deepEqual(result, { verified: true });
  assert.deepEqual(h.calls, ["identity", "videos.list", "backup", "liveWrites", "videos.update", "videos.list"]);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].videoId, "BC1");
  assert.deepEqual(h.updates[0].payload.localizations, { fr: { title: "Ft", description: "Fd2" }, it: { title: "Io", description: "Id" }, de: { title: "Dt", description: "Dd" } });
  assert.deepEqual(h.updates[0].payload.snippet, { title: "T", description: "D", tags: ["jazz", "lofi"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en-US" });
});

test("the audio language zxx (refused when echoed) is not sent back", async () => {
  const video = baseVideo();
  video.snippet.defaultAudioLanguage = "zxx";
  const h = harness({ video });
  await h.apply();
  assert.equal("defaultAudioLanguage" in h.updates[0].payload.snippet, false);
});

test("backup before the write: the fresh title, description, default language and every localization; audit BACKUP, RESULT, VERIFICATION", async () => {
  const h = harness();
  await h.apply();
  assert.equal(h.backups.length, 1);
  assert.deepEqual(h.backups[0], {
    channelId: "UC1",
    operationId: "op1",
    videoId: "BC1",
    snapshot: {
      kind: "localization",
      defaultLanguage: "en",
      existingLocalizations: { en: { title: "T", description: "D" }, fr: { title: "Fo", description: "Fd" }, it: { title: "Io", description: "Id" } },
      snippetTitle: "T",
      snippetDescription: "D",
    },
  });
  assert.deepEqual(h.audit.map((a) => a.eventType), ["BACKUP", "RESULT", "VERIFICATION"]);
  assert.equal(h.audit[0].detail.source, "live_localizations");
  assert.deepEqual(h.audit[1].detail.languages, ["de", "fr"]);
  assert.equal(h.audit[2].detail.verified, true);
});

test("AC-LL-02: the video's own default language in the set fails closed -- no backup, no update", async () => {
  const video = baseVideo();
  video.snippet.defaultLanguage = "de";
  const h = harness({ video });
  await assert.rejects(() => h.apply(), (error: unknown) => error instanceof DomainError && error.code === "validation_failed" && /de/.test(error.message));
  assert.deepEqual(h.calls, ["identity", "videos.list"]);
  assert.deepEqual(h.updates, []);
  // In any letter case.
  const upper = baseVideo();
  upper.snippet.defaultLanguage = "DE";
  const h2 = harness({ video: upper });
  await assert.rejects(() => h2.apply());
  assert.deepEqual(h2.updates, []);
});

test("AC-LL-03: a fresh read without a default language writes nothing", async () => {
  const video = baseVideo();
  video.snippet.defaultLanguage = null;
  const h = harness({ video });
  await assert.rejects(() => h.apply(), (error: unknown) => error instanceof DomainError && /defaultLanguage/.test(error.message));
  assert.deepEqual(h.calls, ["identity", "videos.list"]);
  assert.deepEqual(h.updates, []);
});

test("a video YouTube does not return writes nothing", async () => {
  const h = harness({ video: null });
  await assert.rejects(() => h.apply(), (error: unknown) => error instanceof DomainError && error.code === "not_found");
  assert.deepEqual(h.updates, []);
});

test("AC-LL-08: a read-back missing de is not verified -- 'language missing', after the bounded re-reads", async () => {
  const h = harness({
    afterWrite: (payload, current) => {
      const { de, ...rest } = payload.localizations;
      void de;
      return { snippet: current.snippet, localizations: { ...rest, en: { title: "T", description: "D" } } };
    },
  });
  const result = await h.apply();
  assert.equal(result.verified, false);
  if (result.verified) return;
  assert.match(result.detail, /language missing: de/);
  assert.doesNotMatch(result.detail, /text differs/);
  // 1 read-back + 2 re-reads (3 attempts), a pause before each re-read.
  assert.deepEqual(h.calls.slice(h.calls.indexOf("videos.update") + 1), ["videos.list", "sleep", "videos.list", "sleep", "videos.list"]);
  assert.equal(h.audit.at(-1)?.eventType, "VERIFICATION");
  assert.equal(h.audit.at(-1)?.detail.verified, false);
});

test("read-back: a language present with other text is told apart from a missing one ('text differs')", async () => {
  const h = harness({
    afterWrite: (payload, current) => ({ snippet: current.snippet, localizations: { ...payload.localizations, fr: { title: "Fo", description: "Fd" } } }),
  });
  const result = await h.apply();
  assert.equal(result.verified, false);
  if (!result.verified) {
    assert.match(result.detail, /text differs: fr/);
    assert.doesNotMatch(result.detail, /language missing/);
  }
});

test("read-back: the snippet title or description changed by the write is not verified", async () => {
  const h = harness({ afterWrite: (payload, current) => ({ snippet: { ...current.snippet, title: "Other" }, localizations: { ...payload.localizations } }) });
  const result = await h.apply();
  assert.equal(result.verified, false);
  if (!result.verified) assert.match(result.detail, /base title or description/);
});

test("read-back: a key read back in other letter case counts as the language (pt-br for pt-BR)", async () => {
  const h = harness({
    afterWrite: (payload, current) => ({
      snippet: current.snippet,
      localizations: Object.fromEntries(Object.entries(payload.localizations).map(([key, value]) => [key === "pt-BR" ? "pt-br" : key, value])),
    }),
  });
  const result = await h.apply({ "pt-BR": { title: "Pt", description: "Pd" } });
  assert.deepEqual(result, { verified: true });
});

test("AC-LL-09: Live writes off -- live_writes_disabled, the update is never sent", async () => {
  const h = harness({ liveWrites: false });
  await assert.rejects(() => h.apply(), (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled");
  assert.deepEqual(h.updates, []);
  assert.equal(h.calls.includes("videos.update"), false);
  // Checked immediately before the write, after the backup.
  assert.deepEqual(h.calls, ["identity", "videos.list", "backup", "liveWrites"]);
});

test("AC-LL-09: the identity check fails -- no read, no backup, no write", async () => {
  const h = harness({ wrongChannel: true });
  await assert.rejects(() => h.apply(), /authorized channel is not UC1/);
  assert.deepEqual(h.calls, ["identity"]);
  assert.deepEqual(h.updates, []);
});

test("an unreachable backup store writes nothing", async () => {
  const h = harness({ backupUnhealthy: true });
  await assert.rejects(() => h.apply(), (error: unknown) => error instanceof DomainError && error.code === "backup_infrastructure_unavailable");
  assert.deepEqual(h.updates, []);
});

test("the fields just written must read back first: a stale read (old tags) is re-read, never echoed back over them", async () => {
  const h = harness({ staleReads: 1 });
  const result = await h.apply(SET, { tags: ["lofi", "jazz"], categoryId: "10", defaultLanguage: "en" });
  assert.deepEqual(result, { verified: true });
  assert.deepEqual(h.calls.slice(0, 4), ["identity", "videos.list", "sleep", "videos.list"]);
  // Tags compare in any order (a live broadcast reads them back sorted); the update carries the fresh, current ones.
  assert.deepEqual(h.updates[0].payload.snippet.tags, ["jazz", "lofi"]);
});

test("the fields never read back as written: nothing is sent (the snippet would undo them)", async () => {
  const h = harness({ staleReads: 10 });
  await assert.rejects(() => h.apply(SET, { tags: ["jazz", "lofi"] }), (error: unknown) => error instanceof DomainError && error.code === "update_failed");
  assert.deepEqual(h.updates, []);
  assert.equal(h.calls.includes("backup"), false);
});

test("an empty set sends nothing at all", async () => {
  const h = harness();
  assert.deepEqual(await h.apply({}), { verified: true });
  assert.deepEqual(h.calls, []);
});
