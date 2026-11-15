import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { ChannelLocalizationsDependencies, ChannelLocalizationsLastApply } from "./contracts";
import { createChannelLocalizationsService } from "./services";
import { previewChannelLocalizations, type LiveChannelLocalizations } from "./set";
import { operatorSurface } from "./index";

// BL-210 acceptance (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md AC-CL-01..09, written before the code; AC-CL-08/09 amended by
// the owner's decision msg 3350: no brandingSettings write -- a channel without a default language is refused; review #1/#2 cases). Every expected value is written by hand from the plan, PROJECT_SPEC §21 (keep every other
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
  // The version of the stored set the owner previewed (review #2): computed here independently -- SHA-256 of the stored column.
  const version = () => createHash("sha256").update(row.localizationsJson ?? "").digest("hex");
  const service = createChannelLocalizationsService(deps);
  return { service, apply: (setVersion: string = version()) => service.apply("UC1", { userId: "user-1" }, setVersion), version, state, calls, localizationWrites, events, backups, row };
}

const writeCalls = (calls: string[]) => calls.filter((c) => c === "updateLocalizations");

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
  const result = await h.apply();
  assert.deepEqual(h.localizationWrites, [
    { fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } },
  ]);
  // The base title/description are not sent anywhere: the only write is the localizations part.
  assert.deepEqual(result, { at: "2026-10-22T10:00:00.000Z", ok: true, languages: ["es", "de"], writes: 1, backupPath: "/backups/UC1/op-1/UC1.metadata_before.json" });
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
  await h.apply();
  assert.deepEqual(h.localizationWrites, [{ ja: { title: "Ja", description: "Ja desc" }, es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } }]);
});

test("AC-CL-05: the active credentials belong to another channel -> refused before any read or write", async () => {
  const h = harness({ activeChannel: "UC_OTHER" });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && (e.code as string) === "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(h.calls, ["identity"]);
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal((JSON.parse(h.row.lastApplyJson as string) as ChannelLocalizationsLastApply).ok, false);
});

test("AC-CL-06: Live writes off -> refused, and no gateway write is made", async () => {
  const h = harness({ liveWrites: false });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && e.code === "live_writes_disabled");
  assert.deepEqual(writeCalls(h.calls), []);
  const last = JSON.parse(h.row.lastApplyJson as string) as ChannelLocalizationsLastApply;
  assert.deepEqual(last.ok === false ? [last.failure, last.detail] : null, ["failed", "live_writes_disabled"]);
});

test("AC-CL-07: the read-back shows es differing -> ok:false, read_back_mismatch, and the backup is kept", async () => {
  const h = harness({ tamper: (state) => void (state.localizations.es = { title: "Es", description: "something else" }) });
  const result = await h.apply();
  assert.deepEqual(result, {
    at: "2026-10-22T10:00:00.000Z",
    ok: false,
    failure: "read_back_mismatch",
    detail: "text differs: es",
    languages: ["es", "de"],
    writes: 1,
    backupPath: "/backups/UC1/op-1/UC1.metadata_before.json",
  });
  assert.equal(h.backups.length, 1);
  assert.deepEqual(JSON.parse(h.row.lastApplyJson as string), result);
  // Two reads after the write (attempts: 2), then given up.
  assert.deepEqual(h.calls.slice(-2), ["read", "read"]);
});

// AC-CL-08 and AC-CL-09 as amended by the owner's decision (msg 3350): the app never writes brandingSettings. The plan's original
// AC-CL-08 (set the baseline as the default language) and AC-CL-09 (no baseline -> no_baseline) are replaced: the requirement
// changed to "brandingSettings.channel.defaultLanguage not set -> refused, nothing written" (review #5: snippet alone does not count).
test("AC-CL-08 (amended, msg 3350): no default language on the channel -> channel_default_language_not_set, no backup and no write", async () => {
  const h = harness({ live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: null }, brandingChannel: { title: "Base", description: "Base desc" } }) });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && (e.code as string) === "channel_default_language_not_set");
  assert.deepEqual(h.calls, ["identity", "read"]);
});

test("AC-CL-09 (amended, msg 3350; review #5): only snippet.defaultLanguage set, branding not set -> refused, no write", async () => {
  const h = harness({ live: liveChannel({ brandingChannel: { title: "Base", description: "Base desc" } }) });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && (e.code as string) === "channel_default_language_not_set");
  assert.deepEqual(writeCalls(h.calls), []);
});

test("review #1: YouTube lists an own-language (en) entry differing from the base text -> own_language_in_live, nothing written", async () => {
  const h = harness({ live: liveChannel({ localizations: { en: { title: "Other name", description: "Base desc" }, fr: { title: "Fr", description: "Fr desc" } } }) });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && (e.code as string) === "own_language_in_live");
  assert.deepEqual(writeCalls(h.calls), []);
  assert.deepEqual(h.backups, []);
});

test("review #1: an own-language (en) entry equal to the base text is sent back unchanged, not dropped; read-back ok", async () => {
  const h = harness({ live: liveChannel({ localizations: { en: { title: "Base", description: "Base desc" }, fr: { title: "Fr", description: "Fr desc" } } }) });
  const result = await h.apply();
  assert.deepEqual(h.localizationWrites, [
    { fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" }, en: { title: "Base", description: "Base desc" } },
  ]);
  assert.equal(result.ok, true);
});

test("review #2: the Operator saves set B between the preview and the apply -> localizations_changed, nothing read or written", async () => {
  const h = harness();
  const preview = await h.service.preview("UC1");
  assert.equal(preview.setVersion, h.version());
  await h.service.save("UC1", { it: { title: "It", description: "It desc" } }, "factory");
  h.calls.length = 0;
  await assert.rejects(h.apply(preview.setVersion), (e: unknown) => e instanceof DomainError && (e.code as string) === "localizations_changed");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.localizationWrites, []);
  // A missing version is refused too.
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, undefined), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
});

test("the two default-language fields disagree -> default_language_mismatch, nothing written", async () => {
  const h = harness({ live: liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: "fr" } }) });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && e.code === "default_language_mismatch");
  assert.deepEqual(writeCalls(h.calls), []);
});

test("the set holds the channel's own language on YouTube (it differs from the baseline) -> refused, nothing written", async () => {
  const h = harness({ baseline: "ru", stored: { en: { title: "En", description: "En desc" } } });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.deepEqual(writeCalls(h.calls), []);
});

test("the channel changes on YouTube between the read and the write -> update_failed, nothing written, the backup kept", async () => {
  const h = harness({ changeAfterFirstRead: (state) => void (state.localizations.it = { title: "It", description: "It desc" }) });
  await assert.rejects(h.apply(), (e: unknown) => e instanceof DomainError && e.code === "update_failed");
  assert.deepEqual(writeCalls(h.calls), []);
  assert.equal(h.backups.length, 1);
});

test("every language already as stored -> nothing written (0 writes), ok", async () => {
  const h = harness({ live: liveChannel({ localizations: { es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" } } }) });
  const result = await h.apply();
  assert.deepEqual(result, { at: "2026-10-22T10:00:00.000Z", ok: true, languages: [], writes: 0, backupPath: null });
  assert.deepEqual(h.calls, ["identity", "read"]);
});

test("preview: new / changed / unchanged, untouched languages (the equal own-language entry among them), default language and quota", () => {
  const live = liveChannel({
    localizations: { en: { title: "Base", description: "Base desc" }, fr: { title: "Fr", description: "Fr desc" }, es: { title: "Es old", description: "Es desc" }, de: { title: "De", description: "De desc" } },
  });
  const set = { es: { title: "Es", description: "Es desc" }, de: { title: "De", description: "De desc" }, it: { title: "It", description: "It desc" } };
  assert.deepEqual(previewChannelLocalizations(set, live), {
    languages: [
      { language: "es", status: "changed" },
      { language: "de", status: "unchanged" },
      { language: "it", status: "new" },
    ],
    untouched: ["en", "fr"],
    defaultLanguage: { current: "en" },
    problems: [],
    quota: { writes: 1, writeUnits: 50, readUnits: 3 },
    ownLanguage: "en",
  });
  const noDefault = liveChannel({ snippet: { title: "Base", description: "Base desc", defaultLanguage: "en" }, brandingChannel: { title: "Base" } });
  const refused = previewChannelLocalizations({ it: { title: "It", description: "It desc" } }, noDefault);
  assert.deepEqual([refused.problems, refused.quota, refused.defaultLanguage], [["default_language_not_set"], { writes: 0, writeUnits: 0, readUnits: 1 }, { current: null }]);
  const ownDiffers = liveChannel({ localizations: { en: { title: "Base", description: "Other" } } });
  assert.deepEqual(previewChannelLocalizations({ it: { title: "It", description: "It desc" } }, ownDiffers).problems, ["own_language_in_live"]);
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

// ---------------------------------------------------------------------------
// Locale keys (owner msg 4387, 2026-11-15, Tropico): a channel's translations made in YouTube Studio are keyed like `de_DE`,
// `zh_CN`, `pt_BR`. Sending the set's `de` next to an existing `de_DE` left the old German text on YouTube (YouTube folded the two
// keys and kept the old one) and the read-back reported "language missing". Requirement (PROJECT_SPEC §21: replace the set's
// languages, keep every other, nothing deleted): a set language is written INTO the channel's existing key for that language --
// the same key in any case; the same code with `_` for `-` (zh-CN = zh_CN); or, for a language without a region (de), the one key
// of that language (de_DE) -- and never as a second key. Two or more candidates (es_ES and es_419 for `es`): refused, nothing
// written. Expected values written by hand.
// ---------------------------------------------------------------------------

test("CL-KEY-01: the channel holds de_DE (old) and zh_CN; the set de and zh-CN -> written into de_DE and zh_CN, no de / zh-CN key; read-back ok", async () => {
  const h = harness({
    live: liveChannel({ localizations: { de_DE: { title: "Base", description: "Base" }, zh_CN: { title: "Zh old", description: "Zh old desc" }, fr_FR: { title: "Fr", description: "Fr desc" } } }),
    stored: { de: { title: "De", description: "De new desc" }, "zh-CN": { title: "Zh", description: "Zh new desc" } },
  });
  const result = await h.apply();
  assert.deepEqual(h.localizationWrites, [
    { de_DE: { title: "De", description: "De new desc" }, zh_CN: { title: "Zh", description: "Zh new desc" }, fr_FR: { title: "Fr", description: "Fr desc" } },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.languages, ["de", "zh-CN"]);
});

test("CL-KEY-02: an exact key wins over a regional one (es and es_ES both on YouTube, the set es -> es)", async () => {
  const h = harness({
    live: liveChannel({ localizations: { es: { title: "Es old", description: "x" }, es_ES: { title: "EsES", description: "y" } } }),
    stored: { es: { title: "Es", description: "Es desc" } },
  });
  await h.apply();
  assert.deepEqual(h.localizationWrites, [{ es: { title: "Es", description: "Es desc" }, es_ES: { title: "EsES", description: "y" } }]);
});

test("CL-KEY-03: two keys for one language (es_ES and es_419, the set es) -> refused, no backup and no write", async () => {
  const h = harness({
    live: liveChannel({ localizations: { es_ES: { title: "A", description: "a" }, es_419: { title: "B", description: "b" } } }),
    stored: { es: { title: "Es", description: "Es desc" } },
  });
  await assert.rejects(h.apply(), (error: unknown) => error instanceof DomainError && error.code === "validation_failed" && /es/.test(error.message));
  assert.equal(writeCalls(h.calls).length, 0);
  assert.ok(!h.calls.includes("backup"));
});

test("CL-KEY-04: preview reads de against de_DE: same text unchanged, other text changed; de_DE is not listed as untouched", () => {
  const live = liveChannel({ localizations: { de_DE: { title: "De", description: "De desc" }, ja_JP: { title: "Ja", description: "Ja desc" } } });
  const same = previewChannelLocalizations({ de: { title: "De", description: "De desc" } }, live);
  assert.deepEqual(same.languages, [{ language: "de", status: "unchanged" }]);
  assert.deepEqual(same.untouched, ["ja_JP"]);
  assert.equal(same.quota.writes, 0);
  const other = previewChannelLocalizations({ de: { title: "De", description: "New" } }, live);
  assert.deepEqual(other.languages, [{ language: "de", status: "changed" }]);
  const ambiguous = previewChannelLocalizations({ es: { title: "Es", description: "x" } }, liveChannel({ localizations: { es_ES: { title: "A", description: "a" }, es_419: { title: "B", description: "b" } } }));
  assert.ok(ambiguous.problems.includes("language_key_ambiguous"));
});
