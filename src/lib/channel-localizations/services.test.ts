import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { ChannelLocalizationsDependencies, ChannelLocalizationsLastApply } from "./contracts";
import { createChannelLocalizationsService } from "./services";
import { previewChannelLocalizations, type LiveChannelLocalizations } from "./set";
import { operatorSurface } from "./index";

// BL-210 acceptance (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md AC-CL-01..09, written before the code; "API facts" for the
// two-write default-language case). Every expected value is written by hand from the plan, PROJECT_SPEC §21 (keep every other
// language, the base text untouched, nothing deleted) and the channels.update reference -- never computed by the code under test.

type Live = LiveChannelLocalizations;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const BRANDING = { title: "Base", description: "Base desc", keywords: "music \"lo fi\"", country: "JP", unsubscribedTrailer: "abcdefghijk", defaultLanguage: "en", moderateComments: true };

function liveChannel(overrides: Partial<Live> = {}): Live {
  return {
    snippet: { title: "Base", description: "Base desc", defaultLanguage: "en" },
    brandingChannel: { ...BRANDING },
    localizations: {},
    ...overrides,
  };
}

function harness(options: {
  live?: Live;
  baseline?: string | null;
  stored?: Record<string, { title: string; description: string }> | null;
  activeChannel?: string;
  liveWrites?: boolean;
  /** Changes what YouTube stores after a localizations write (simulates a read-back difference). */
  tamper?: (state: Live) => void;
  /** Changes the channel between the first and the second read (an edit in Studio meanwhile). */
  changeAfterFirstRead?: (state: Live) => void;
} = {}) {
  const state: Live = clone(options.live ?? liveChannel());
  const calls: string[] = [];
  const brandingWrites: Array<Record<string, unknown>> = [];
  const localizationWrites: Array<Record<string, { title: string; description: string }>> = [];
  const events: Array<{ kind: string; detail: unknown }> = [];
  const backups: unknown[] = [];
  let reads = 0;
  const row = {
    localizationsJson: options.stored === undefined ? JSON.stringify({ es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } }) : options.stored === null ? null : JSON.stringify(options.stored),
    updatedAt: null as Date | null,
    updatedBy: null as string | null,
    lastApplyJson: null as string | null,
  };
  const deps: ChannelLocalizationsDependencies = {
    store: {
      get: async () => ({ ...row }),
      saveSet: async (_channelId, set) => {
        row.localizationsJson = set.localizationsJson;
        row.updatedAt = set.updatedAt;
        row.updatedBy = set.updatedBy;
      },
      saveLastApply: async (_channelId, result) => {
        row.lastApplyJson = result.lastApplyJson;
      },
    },
    channel: async (channelId) => (channelId === "UC1" ? { connectedUserId: "user-1" } : null),
    baselineLanguage: async () => (options.baseline === undefined ? "en" : options.baseline),
    auth: { resolve: async () => ({ accessToken: "a", refreshToken: "r", channelId: options.activeChannel ?? "UC1" }) as never },
    writeContext: {
      assertWriteChannel: async ({ credentials, expectedChannelId }) => {
        calls.push("identity");
        if ((credentials as unknown as { channelId: string }).channelId !== expectedChannelId) {
          throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH" as never, message: "wrong channel" });
        }
      },
    },
    youtube: {
      read: async () => {
        calls.push("read");
        reads++;
        const snapshot = clone(state);
        if (reads === 1 && options.changeAfterFirstRead) options.changeAfterFirstRead(state);
        return snapshot;
      },
      assertLiveWritesAuthorized: async () => {
        calls.push("liveWrites");
        if (options.liveWrites === false) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      },
      updateBrandingChannel: async (_credentials, _channelId, channel) => {
        calls.push("updateBranding");
        brandingWrites.push(clone(channel));
        // channels.update replaces the part: the omitted title is kept by YouTube (it may only be omitted), anything else as sent.
        state.brandingChannel = { title: state.brandingChannel.title, ...clone(channel) };
        if (typeof channel.defaultLanguage === "string") state.snippet.defaultLanguage = channel.defaultLanguage;
      },
      updateLocalizations: async (_credentials, _channelId, localizations) => {
        calls.push("updateLocalizations");
        localizationWrites.push(clone(localizations));
        state.localizations = clone(localizations);
        options.tamper?.(state);
      },
    },
    backup: {
      checkInfrastructureHealth: async () => ({ healthy: true }),
      captureBackup: async (args) => {
        calls.push("backup");
        backups.push(clone(args));
        return { path: `/backups/${args.channelId}/op-1/${args.subjectId}.metadata_before.json`, capturedAt: "2026-10-22T10:00:00.000Z" };
      },
    },
    audit: { record: async ({ kind, detail }) => void events.push({ kind, detail }) },
    sleep: async () => undefined,
    clock: () => new Date("2026-10-22T10:00:00.000Z"),
    newId: () => "op-1",
    readBack: { attempts: 2, delayMs: 0 },
  };
  return { service: createChannelLocalizationsService(deps), state, calls, brandingWrites, localizationWrites, events, backups, row };
}

const writeCalls = (calls: string[]) => calls.filter((c) => c === "updateBranding" || c === "updateLocalizations");

test("AC-CL-01: saving a valid set (es, de) stores it, records who saved it, and sends nothing to YouTube", async () => {
  const h = harness({ stored: null });
  const saved = await h.service.save("UC1", { es: { title: " Es ", description: "Es desc\r\n" }, de: { title: "De", description: "De desc" } }, "factory");
  assert.deepEqual(saved, { localizations: { es: { title: "Es", description: "Es desc\n" }, de: { title: "De", description: "De desc" } } });
  assert.equal(h.row.localizationsJson, JSON.stringify({ es: { title: "Es", description: "Es desc\n" }, de: { title: "De", description: "De desc" } }));
  assert.equal(h.row.updatedBy, "factory");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.events, [{ kind: "saved", detail: { languages: ["es", "de"], by: "factory" } }]);
});

test("AC-CL-02: pt-br (hint pt-BR), the base language, a title over 30 characters and < in a description refuse the whole save", async () => {
  const h = harness({ stored: null });
  const error = await h.service
    .save("UC1", {
      "pt-br": { title: "Pt", description: "Pt desc" },
      en: { title: "En", description: "En desc" },
      de: { title: "a".repeat(31), description: "De desc" },
      fr: { title: "Fr", description: "a <b> c" },
    }, "owner")
    .catch((e: unknown) => e);
  assert.ok(error instanceof DomainError);
  assert.equal(error.code, "validation_failed");
  const refused = (error.details as { refused: Array<{ language: string; reason: string; hint?: string }> }).refused.map(({ language, reason, hint }) => ({ language, reason, ...(hint ? { hint } : {}) }));
  assert.deepEqual(refused, [
    { language: "pt-br", reason: "unsupported_language", hint: "pt-BR" },
    { language: "en", reason: "baseline_language" },
    { language: "de", reason: "title_too_long" },
    { language: "fr", reason: "description_angle_brackets" },
  ]);
  assert.equal(h.row.localizationsJson, null);
  assert.deepEqual(h.events, []);
});

test("a save for a channel not connected here is refused (channel_not_connected); an empty set clears the stored one", async () => {
  const h = harness();
  await assert.rejects(h.service.save("UC_OTHER", {}, "factory"), (e: unknown) => e instanceof DomainError && e.code === "channel_not_connected");
  await h.service.save("UC1", {}, "owner");
  assert.equal(h.row.localizationsJson, null);
});

test("AC-CL-03: the channel holds fr and es, the set es and de -> one localizations write with fr unchanged, es and de new; read-back ok", async () => {
  const h = harness({ live: liveChannel({ localizations: { fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es old", description: "Es old desc" } } }) });
  const result = await h.service.apply("UC1", { userId: "user-1" });
  assert.deepEqual(h.localizationWrites, [
    { fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } },
  ]);
  // The base title/description are not sent anywhere: no snippet part exists, and no branding write was made.
  assert.deepEqual(h.brandingWrites, []);
  assert.deepEqual(result, { at: "2026-10-22T10:00:00.000Z", ok: true, languages: ["es", "de"], defaultLanguageSet: null, writes: 1, backupPath: "/backups/UC1/op-1/UC1.metadata_before.json" });
  // Identity first, then reads, the backup, the re-read, Live writes immediately before the one write, then the read-back.
  assert.deepEqual(h.calls, ["identity", "read", "backup", "read", "liveWrites", "updateLocalizations", "read"]);
  assert.deepEqual(h.state.snippet, { title: "Base", description: "Base desc", defaultLanguage: "en" });
  assert.deepEqual(JSON.parse(h.row.lastApplyJson as string), result);
  assert.deepEqual(h.events.map((e) => e.kind), ["backup", "write", "verification"]);
  assert.deepEqual(h.backups, [
    {
      channelId: "UC1",
      operationId: "op-1",
      subjectId: "UC1",
      snapshot: { kind: "channel_localizations", snippet: { title: "Base", description: "Base desc", defaultLanguage: "en" }, brandingChannel: BRANDING, localizations: { fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es old", description: "Es old desc" } } },
    },
  ]);
});

test("AC-CL-04: a language the set does not name (ja) is still sent: nothing is deleted", async () => {
  const h = harness({ live: liveChannel({ localizations: { ja: { title: "Ja", description: "Ja desc" } } }) });
  await h.service.apply("UC1", { userId: "user-1" });
  assert.deepEqual(h.localizationWrites, [{ ja: { title: "Ja", description: "Ja desc" }, es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } }]);
});

test("AC-CL-05: the active credentials belong to another channel -> refused before any read or write", async () => {
  const h = harness({ activeChannel: "UC_OTHER" });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && (e.code as string) === "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(h.calls, ["identity"]);
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal((JSON.parse(h.row.lastApplyJson as string) as ChannelLocalizationsLastApply).ok, false);
});

test("AC-CL-06: Live writes off -> refused, and no gateway write is made", async () => {
  const h = harness({ liveWrites: false });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && e.code === "live_writes_disabled");
  assert.deepEqual(writeCalls(h.calls), []);
  const last = JSON.parse(h.row.lastApplyJson as string) as ChannelLocalizationsLastApply;
  assert.deepEqual(last.ok === false ? [last.failure, last.detail] : null, ["failed", "live_writes_disabled"]);
});

test("AC-CL-07: the read-back shows es differing -> ok:false, read_back_mismatch, and the backup is kept", async () => {
  const h = harness({ tamper: (state) => void (state.localizations.es = { title: "Es", description: "something else" }) });
  const result = await h.service.apply("UC1", { userId: "user-1" });
  assert.deepEqual(result, {
    at: "2026-10-22T10:00:00.000Z",
    ok: false,
    failure: "read_back_mismatch",
    detail: "text differs: es",
    languages: ["es", "de"],
    defaultLanguageSet: null,
    writes: 1,
    backupPath: "/backups/UC1/op-1/UC1.metadata_before.json",
  });
  assert.equal(h.backups.length, 1);
  assert.deepEqual(JSON.parse(h.row.lastApplyJson as string), result);
  // Two reads after the write (attempts: 2), then given up.
  assert.deepEqual(h.calls.slice(-2), ["read", "read"]);
});

test("AC-CL-08: no default language, baseline en -> a brandingSettings write sets it to en, every other settable field as read; then the translations", async () => {
  const branding = { title: "Base", description: "Base desc", keywords: "music \"lo fi\"", country: "JP", unsubscribedTrailer: "abcdefghijk", trackingAnalyticsAccountId: "UA-1", moderateComments: true };
  const h = harness({ live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: null }, brandingChannel: branding }) });
  const result = await h.service.apply("UC1", { userId: "user-1" });
  // Exactly the six settable fields read with a value; the title left out (channelTitleUpdateForbidden); defaultLanguage the baseline.
  assert.deepEqual(h.brandingWrites, [{ description: "Base desc", keywords: "music \"lo fi\"", country: "JP", unsubscribedTrailer: "abcdefghijk", trackingAnalyticsAccountId: "UA-1", defaultLanguage: "en" }]);
  assert.deepEqual(h.localizationWrites, [{ es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } }]);
  // Each write has its own Live-writes check immediately before it; each is read back before the next step.
  assert.deepEqual(h.calls, ["identity", "read", "backup", "read", "liveWrites", "updateBranding", "read", "liveWrites", "updateLocalizations", "read"]);
  assert.deepEqual(result, { at: "2026-10-22T10:00:00.000Z", ok: true, languages: ["es", "de"], defaultLanguageSet: "en", writes: 2, backupPath: "/backups/UC1/op-1/UC1.metadata_before.json" });
});

test("AC-CL-08: a branding field read back changed -> ok:false read_back_mismatch, and the translations are not written", async () => {
  // YouTube may truncate keywords holding an unescaped quote (channels resource): after the branding write it stores "a", not "a\"b".
  const base = harness({ live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: null }, brandingChannel: { title: "Base", description: "Base desc", keywords: "a\"b" } }) });
  const tampered = await tamperingApply(base, { title: "Base", description: "Base desc", keywords: "a", defaultLanguage: "en" });
  assert.deepEqual(tampered.result.ok === false ? [tampered.result.failure, tampered.result.detail] : null, ["read_back_mismatch", "branding field changed: keywords"]);
  assert.deepEqual(tampered.localizationWrites, []);
});

/** Runs an apply whose branding write YouTube stores as `stored` (a separate fake: the default one keeps what is sent). */
async function tamperingApply(base: ReturnType<typeof harness>, stored: Record<string, unknown>) {
  const localizationWrites: unknown[] = [];
  const state = base.state;
  const deps = {
    store: { get: async () => ({ localizationsJson: base.row.localizationsJson, updatedAt: null, updatedBy: null, lastApplyJson: null }), saveSet: async () => undefined, saveLastApply: async () => undefined },
    channel: async () => ({ connectedUserId: "user-1" }),
    baselineLanguage: async () => "en",
    auth: { resolve: async () => ({ accessToken: "a", refreshToken: "r" }) as never },
    writeContext: { assertWriteChannel: async () => undefined },
    youtube: {
      read: async () => clone(state),
      assertLiveWritesAuthorized: async () => undefined,
      updateBrandingChannel: async () => void (state.brandingChannel = clone(stored)),
      updateLocalizations: async (_c: unknown, _id: string, l: unknown) => void localizationWrites.push(l),
    },
    backup: { checkInfrastructureHealth: async () => ({ healthy: true }), captureBackup: async () => ({ path: "/b", capturedAt: "x" }) },
    audit: { record: async () => undefined },
    sleep: async () => undefined,
    clock: () => new Date("2026-10-22T10:00:00.000Z"),
    newId: () => "op-1",
    readBack: { attempts: 1, delayMs: 0 },
  } as unknown as ChannelLocalizationsDependencies;
  const result = await createChannelLocalizationsService(deps).apply("UC1", { userId: "user-1" });
  return { result, localizationWrites };
}

test("AC-CL-09: no default language and no baseline -> no_baseline, no backup and no write", async () => {
  const h = harness({ baseline: null, live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: null }, brandingChannel: { title: "Base" } }) });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && e.code === "no_baseline");
  assert.deepEqual(h.calls, ["identity", "read"]);
});

test("the two default-language fields disagree -> default_language_mismatch, nothing written", async () => {
  const h = harness({ live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: "fr" } }) });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && e.code === "default_language_mismatch");
  assert.deepEqual(writeCalls(h.calls), []);
});

test("the set holds the channel's own language on YouTube (it differs from the baseline) -> refused, nothing written", async () => {
  const h = harness({ baseline: "ru", stored: { en: { title: "En", description: "En desc" } } });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.deepEqual(writeCalls(h.calls), []);
});

test("the channel changes on YouTube between the read and the write -> update_failed, nothing written, the backup kept", async () => {
  const h = harness({ changeAfterFirstRead: (state) => void (state.localizations.it = { title: "It", description: "It desc" }) });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }), (e: unknown) => e instanceof DomainError && e.code === "update_failed");
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal(h.backups.length, 1);
});

test("every language already as stored -> nothing written (0 writes), ok", async () => {
  const h = harness({ live: liveChannel({ localizations: { es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } } }) });
  const result = await h.service.apply("UC1", { userId: "user-1" });
  assert.deepEqual(result, { at: "2026-10-22T10:00:00.000Z", ok: true, languages: [], defaultLanguageSet: null, writes: 0, backupPath: null });
  assert.deepEqual(h.calls, ["identity", "read"]);
});

test("preview: new / changed / unchanged, untouched languages (the own-language entry aside), default language and quota", () => {
  const live = liveChannel({
    localizations: { en: { title: "Base", description: "Base desc" }, fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es old", description: "Es desc" }, de: { title: "De", description: "De desc" } },
  });
  const set = { es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" }, it: { title: "It", description: "It desc" } };
  assert.deepEqual(previewChannelLocalizations(set, live, "en"), {
    languages: [
      { language: "es", status: "changed" },
      { language: "de", status: "unchanged" },
      { language: "it", status: "new" },
    ],
    untouched: ["fr"],
    defaultLanguage: { current: "en", after: "en", change: false },
    problems: [],
    quota: { writes: 1, writeUnits: 50, readUnits: 3 },
    ownLanguage: "en",
  });
  const noDefault = liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: null }, brandingChannel: { title: "Base" } });
  assert.deepEqual(previewChannelLocalizations({ it: { title: "It", description: "It desc" } }, noDefault, "en").quota, { writes: 2, writeUnits: 100, readUnits: 5 });
  assert.deepEqual(previewChannelLocalizations({ it: { title: "It", description: "It desc" } }, noDefault, null).problems, ["no_baseline"]);
});

test("AC-CL-10 (shape): the Operator's surface has view, live and save -- no apply -- and saves as the factory", async () => {
  const saved: unknown[] = [];
  const surface = operatorSurface({
    view: async () => ({}) as never,
    live: async () => ({}) as never,
    save: async (channelId, input, by) => (saved.push({ channelId, input, by }), { localizations: {} }),
  });
  assert.deepEqual(Object.keys(surface).sort(), ["live", "save", "view"]);
  await surface.save("UC1", {});
  assert.deepEqual(saved, [{ channelId: "UC1", input: {}, by: "factory" }]);
});
