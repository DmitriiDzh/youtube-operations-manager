import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { ChannelBrandingBody, ChannelBrandingDependencies, ChannelBrandingLastApply, LiveChannelBranding } from "./contracts";
import { bannerKindOf, imageDimensions, parseKeywords, serializeKeywords } from "./draft";
import { createChannelBrandingService } from "./services";

// BL-223 (docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md, acceptance AC-CB-01..08 and 10, written before the code; ADR 0050). Expected
// values are fixed by hand from the plan and the Data API reference quoted in its "API facts": description <= 1000 characters,
// keywords space-separated <= 500 characters, banner jpeg/png <= 6 MB, >= 2048x1152, 16:9; channels.update replaces the part whole
// (every settable field sent back as read, the title repeated as read); channelBanners.insert then bannerExternalUrl.

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** A PNG header (signature + IHDR) of the given size, padded to `total` bytes -- enough for the type and size checks. */
function png(width: number, height: number, total = 64): Buffer {
  const bytes = Buffer.alloc(Math.max(total, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A JPEG: SOI, an APP0 segment, then a SOF0 frame header of the given size. */
function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

const GIF = Buffer.from("GIF89a\x00\x0a\x00\x0a", "latin1");

const LOCALIZATIONS = { fr: { title: "Fr", description: "Fr desc" } };

function liveChannel(overrides: Partial<LiveChannelBranding> = {}, branding: Record<string, unknown> = {}): LiveChannelBranding {
  return {
    title: "Tropico",
    avatarUrl: "https://yt3/avatar-800",
    customUrl: "@tropico",
    brandingChannel: {
      title: "Tropico",
      description: "Old description",
      keywords: 'lofi "chill beats"',
      country: "US",
      defaultLanguage: "en",
      unsubscribedTrailer: "VIDEO123456",
      trackingAnalyticsAccountId: "UA-1",
      ...branding,
    },
    bannerExternalUrl: "https://yt3/old-banner",
    localizations: LOCALIZATIONS,
    ...overrides,
  };
}

// `reads`: the answers to channels.list in order -- the preview, the fresh read, the equal re-read, then the read-back(s).
type Harness = ReturnType<typeof harness>;

function harness(options: { reads?: LiveChannelBranding[]; liveWrites?: boolean; updateFails?: boolean; wrongChannel?: boolean; workspace?: Record<string, Buffer> } = {}) {
  const calls: string[] = [];
  const rows = new Map<string, { draftJson: string | null; updatedAt: Date | null; updatedBy: string | null; lastApplyJson: string | null }>();
  const files = new Map<string, Buffer>();
  const events: Array<{ kind: string; detail: unknown }> = [];
  const sent: { banner: Buffer[]; bodies: ChannelBrandingBody[] } = { banner: [], bodies: [] };
  const backups: unknown[] = [];
  let readIndex = 0;
  const reads = options.reads ?? [liveChannel()];
  const deps: ChannelBrandingDependencies = {
    store: {
      get: async (channelId) => rows.get(channelId) ?? null,
      saveDraft: async (channelId, draft) => {
        calls.push("store.saveDraft");
        rows.set(channelId, { ...(rows.get(channelId) ?? { lastApplyJson: null }), ...draft });
      },
      saveLastApply: async (channelId, result) => {
        rows.set(channelId, { ...(rows.get(channelId) ?? { draftJson: null, updatedAt: null, updatedBy: null }), lastApplyJson: result.lastApplyJson });
      },
    },
    banners: {
      write: async (channelId, banner) => {
        calls.push(`banners.write:${banner.mimeType}`);
        files.set(channelId, banner.bytes);
      },
      read: async (channelId) => files.get(channelId) ?? null,
      remove: async (channelId) => {
        files.delete(channelId);
      },
    },
    workspaceFile: async (_channelId, relativePath) => {
      const bytes = options.workspace?.[relativePath];
      if (!bytes) throw new Error(`${relativePath} is not in 99 Data Exchange/Sent to YTM`);
      return { size: bytes.length, read: async () => bytes };
    },
    channel: async (channelId) => (channelId === "UC1" ? { connectedUserId: "user-1" } : null),
    auth: { resolve: async () => ({ accessToken: "t", refreshToken: "r" }) as never },
    writeContext: {
      assertWriteChannel: async () => {
        calls.push("assertWriteChannel");
        if (options.wrongChannel) throw new DomainError({ code: "WRONG_CHANNEL" as never, message: "wrong channel" });
      },
    },
    youtube: {
      read: async () => {
        calls.push("channels.list");
        const read = reads[Math.min(readIndex, reads.length - 1)];
        readIndex++;
        return structuredClone(read);
      },
      assertLiveWritesAuthorized: async () => {
        calls.push("assertLiveWritesAuthorized");
        if (options.liveWrites === false) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      },
      insertBanner: async (_credentials, banner) => {
        calls.push(`channelBanners.insert:${banner.mimeType}`);
        sent.banner.push(banner.bytes);
        return { url: "https://yt3/new-banner" };
      },
      updateBranding: async (_credentials, channelId, body) => {
        calls.push(`channels.update:${channelId}`);
        if (options.updateFails) throw new DomainError({ code: "update_failed", message: "brandingValidationError" });
        sent.bodies.push(structuredClone(body));
      },
    },
    backup: {
      checkInfrastructureHealth: async () => ({ healthy: true }),
      captureBackup: async (args) => {
        calls.push("backup");
        backups.push(args.snapshot);
        return { path: "/backups/b1.json", capturedAt: "2026-10-25T10:00:00.000Z" };
      },
    },
    audit: {
      record: async (args) => {
        events.push({ kind: args.kind, detail: args.detail });
      },
    },
    sha256: sha,
    sleep: async () => undefined,
    clock: () => new Date("2026-10-25T10:00:00.000Z"),
    newId: () => "op-1",
    readBack: { attempts: 2, delayMs: 0 },
  };
  const service = createChannelBrandingService(deps);
  const writeCalls = () => calls.filter((c) => c.startsWith("channelBanners.insert") || c.startsWith("channels.update"));
  return { service, calls, rows, files, events, sent, backups, writeCalls, deps };
}

async function previewVersion(h: Harness): Promise<string> {
  return (await h.service.preview("UC1")).draftVersion;
}

// --- the pure header and keyword helpers (the fixtures above are checked by hand) -------------------------------------------------

test("header reading: PNG IHDR and JPEG SOF0 sizes, type by content", () => {
  assert.equal(bannerKindOf(png(2560, 1440)), "image/png");
  assert.equal(bannerKindOf(jpeg(2048, 1152)), "image/jpeg");
  assert.equal(bannerKindOf(GIF), null);
  assert.deepEqual(imageDimensions(png(2560, 1440), "image/png"), { width: 2560, height: 1440 });
  assert.deepEqual(imageDimensions(jpeg(2048, 1152), "image/jpeg"), { width: 2048, height: 1152 });
});

test("keywords: space-separated, a keyword with a space in double quotes; parsed back as the same list", () => {
  assert.equal(serializeKeywords(["lofi", "chill beats", "jazz"]), 'lofi "chill beats" jazz');
  assert.deepEqual(parseKeywords('lofi "chill beats" jazz'), ["lofi", "chill beats", "jazz"]);
  assert.deepEqual(parseKeywords(""), []);
});

// --- AC-CB-01 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-01: a valid draft (description, keywords, a 2560x1440 PNG) is stored and the banner copied; no YouTube call", async () => {
  const h = harness();
  const banner = png(2560, 1440);
  const result = await h.service.save("UC1", { description: "New description", keywords: ["lofi", "chill beats"], banner: { kind: "bytes", bytes: banner } }, "owner");
  const expected = { description: "New description", keywords: ["lofi", "chill beats"], banner: { sha256: sha(banner), bytes: 64, width: 2560, height: 1440, mimeType: "image/png" } };
  assert.deepEqual(result.draft, expected);
  assert.deepEqual(JSON.parse(h.rows.get("UC1")!.draftJson!), expected);
  assert.equal(h.rows.get("UC1")!.updatedBy, "owner");
  assert.deepEqual(h.files.get("UC1"), banner);
  assert.deepEqual(h.calls, ["banners.write:image/png", "store.saveDraft"]);
  assert.deepEqual((await h.service.view("UC1")).draft, expected);
});

test("AC-CB-01: an agent's banner path inside Sent to YTM is read and copied; keepBanner keeps the stored one; {} clears", async () => {
  const banner = jpeg(2048, 1152);
  const h = harness({ workspace: { "branding/banner.jpg": banner } });
  await h.service.save("UC1", { banner: { kind: "workspace", path: "branding/banner.jpg" } }, "worker");
  assert.equal(JSON.parse(h.rows.get("UC1")!.draftJson!).banner.mimeType, "image/jpeg");
  assert.equal(h.rows.get("UC1")!.updatedBy, "worker");
  await h.service.save("UC1", { description: "D", banner: { kind: "keep" } }, "factory");
  assert.deepEqual(JSON.parse(h.rows.get("UC1")!.draftJson!), { description: "D", banner: { sha256: sha(banner), bytes: banner.length, width: 2048, height: 1152, mimeType: "image/jpeg" } });
  assert.deepEqual(h.files.get("UC1"), banner);
  assert.deepEqual(await h.service.save("UC1", {}, "owner"), { draft: null });
  assert.equal(h.rows.get("UC1")!.draftJson, null);
  assert.equal(h.files.has("UC1"), false, "the copied banner goes with the draft");
});

// --- AC-CB-02 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-02: each bad field refuses the whole draft with details.refused, and nothing is stored", async () => {
  const cases: Array<{ name: string; input: Parameters<Harness["service"]["save"]>[1]; reason: string }> = [
    { name: "2047x1152", input: { description: "ok", banner: { kind: "bytes", bytes: png(2047, 1152) } }, reason: "banner_too_small" },
    { name: "7 MB", input: { description: "ok", banner: { kind: "bytes", bytes: png(2560, 1440, 7 * 1024 * 1024) } }, reason: "banner_too_large" },
    { name: "4:3", input: { description: "ok", banner: { kind: "bytes", bytes: png(2400, 1800) } }, reason: "banner_not_16_9" },
    { name: "GIF", input: { description: "ok", banner: { kind: "bytes", bytes: GIF } }, reason: "banner_not_jpeg_or_png" },
    { name: "description 1001", input: { description: "a".repeat(1001) }, reason: "description_too_long" },
    { name: "path with ..", input: { description: "ok", banner: { kind: "workspace", path: "../secret/banner.png" } }, reason: "banner_path_invalid" },
    { name: "absolute path", input: { description: "ok", banner: { kind: "workspace", path: "/Users/x/banner.png" } }, reason: "banner_path_invalid" },
    { name: "keywords over 500", input: { keywords: Array.from({ length: 101 }, () => "abcd") }, reason: "keywords_too_long" },
    { name: "keyword with a quote", input: { keywords: ['say "hi"'] }, reason: "keyword_quote" },
  ];
  for (const { name, input, reason } of cases) {
    const h = harness();
    await assert.rejects(
      h.service.save("UC1", input, "factory"),
      (error: DomainError) => {
        assert.equal(error.code, "validation_failed", name);
        const refused = (error.details as { refused: Array<{ reason: string }> }).refused;
        assert.deepEqual(refused.map((r) => r.reason), [reason], name);
        return true;
      },
      name
    );
    assert.equal(h.rows.size, 0, `${name}: nothing stored`);
    assert.equal(h.files.size, 0, `${name}: no banner copied`);
  }
});

test("AC-CB-02: limits are inclusive -- 1000 characters and 500 keyword characters (spaces and quotes counted) pass", async () => {
  const h = harness();
  // 100 keywords of 4 letters = 400 + 99 spaces = 499; one quoted two-word keyword "a b" adds 1 space + 5 = 505 > 500.
  await h.service.save("UC1", { description: "я".repeat(1000), keywords: Array.from({ length: 100 }, () => "abcd") }, "owner");
  await assert.rejects(h.service.save("UC1", { keywords: [...Array.from({ length: 100 }, () => "abcd"), "a b"] }, "owner"), { code: "validation_failed" });
});

// --- AC-CB-03 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-03: description + keywords -> one channels.update repeating every other settable field and the title as read; read-back ok", async () => {
  const after = liveChannel({}, { description: "New description", keywords: 'lofi "late night"' });
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel(), after] });
  await h.service.save("UC1", { description: "New description", keywords: ["lofi", "late night"] }, "owner");
  const result = await h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h));
  assert.deepEqual(h.sent.bodies, [
    {
      channel: {
        title: "Tropico",
        country: "US",
        defaultLanguage: "en",
        description: "New description",
        keywords: 'lofi "late night"',
        trackingAnalyticsAccountId: "UA-1",
        unsubscribedTrailer: "VIDEO123456",
      },
      image: { bannerExternalUrl: "https://yt3/old-banner" },
    },
  ]);
  assert.equal(h.sent.banner.length, 0);
  assert.deepEqual(result, { at: "2026-10-25T10:00:00.000Z", ok: true, fields: ["description", "keywords"], writes: 1, backupPath: "/backups/b1.json", banner: null });
  assert.deepEqual(h.backups, [{ kind: "channel_branding", title: "Tropico", brandingChannel: liveChannel().brandingChannel, bannerExternalUrl: "https://yt3/old-banner", localizations: LOCALIZATIONS }]);
  // preview read, fresh read, equal re-read, then Live writes immediately before the one update, then the read-back.
  assert.deepEqual(h.calls.slice(h.calls.indexOf("assertWriteChannel")), ["assertWriteChannel", "channels.list", "backup", "channels.list", "assertLiveWritesAuthorized", "channels.update:UC1", "channels.list"]);
  assert.deepEqual(h.events.map((e) => e.kind), ["saved", "backup", "write", "verification"]);
});

test("AC-CB-03: a field YouTube returns outside the documented settable list is not sent; a cleared description is left out", async () => {
  const before = liveChannel({ bannerExternalUrl: null }, { moderateComments: true });
  const after = liveChannel({ bannerExternalUrl: null }, { moderateComments: true, description: undefined });
  delete after.brandingChannel.description;
  const h = harness({ reads: [before, before, before, after] });
  await h.service.save("UC1", { description: "" }, "owner");
  const result = await h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h));
  assert.deepEqual(h.sent.bodies, [{ channel: { title: "Tropico", country: "US", defaultLanguage: "en", keywords: 'lofi "chill beats"', trackingAnalyticsAccountId: "UA-1", unsubscribedTrailer: "VIDEO123456" } }]);
  assert.equal(result.ok, true);
});

test("nothing different -> nothing written, no backup", async () => {
  const h = harness();
  await h.service.save("UC1", { description: "Old description", keywords: ["lofi", "chill beats"] }, "owner");
  const preview = await h.service.preview("UC1");
  assert.deepEqual(preview.fields, [
    { field: "description", status: "unchanged" },
    { field: "keywords", status: "unchanged" },
  ]);
  assert.deepEqual(preview.quota, { readUnits: 1, writes: 0, writeUnits: 0 });
  const result = await h.service.apply("UC1", { userId: "user-1" }, preview.draftVersion);
  assert.deepEqual(result, { at: "2026-10-25T10:00:00.000Z", ok: true, fields: [], writes: 0, backupPath: null, banner: null });
  assert.deepEqual(h.writeCalls(), []);
  assert.ok(!h.calls.includes("backup"));
});

// --- AC-CB-04 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-04: a banner -> channelBanners.insert, then the update carrying the returned URL; order and Live writes before each", async () => {
  const banner = png(2560, 1440);
  const after = liveChannel({ bannerExternalUrl: "https://yt3/new-banner" });
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel(), after] });
  await h.service.save("UC1", { banner: { kind: "bytes", bytes: banner } }, "owner");
  const preview = await h.service.preview("UC1");
  assert.deepEqual(preview.fields, [{ field: "banner", status: "changed" }]);
  assert.deepEqual(preview.quota, { readUnits: 3, writes: 2, writeUnits: 100 });
  const result = await h.service.apply("UC1", { userId: "user-1" }, preview.draftVersion);
  assert.deepEqual(h.calls.slice(h.calls.indexOf("assertWriteChannel")), [
    "assertWriteChannel",
    "channels.list",
    "backup",
    "channels.list",
    "assertLiveWritesAuthorized",
    "channelBanners.insert:image/png",
    "assertLiveWritesAuthorized",
    "channels.update:UC1",
    "channels.list",
  ]);
  assert.deepEqual(h.sent.banner, [banner]);
  assert.deepEqual(h.sent.bodies[0].image, { bannerExternalUrl: "https://yt3/new-banner" });
  assert.equal(h.sent.bodies[0].channel.description, "Old description", "the other fields as read");
  assert.deepEqual(result, { at: "2026-10-25T10:00:00.000Z", ok: true, fields: ["banner"], writes: 2, backupPath: "/backups/b1.json", banner: { sha256: sha(banner), url: "https://yt3/new-banner" } });
  // The same banner, still on the channel: the next preview says unchanged and nothing is uploaded again.
  const again = harness({ reads: [after] });
  again.rows.set("UC1", h.rows.get("UC1")!);
  again.files.set("UC1", banner);
  assert.deepEqual((await again.service.preview("UC1")).fields, [{ field: "banner", status: "unchanged" }]);
});

test("AC-CB-04: a banner file changed on disk after the save -> branding_changed, nothing written", async () => {
  const h = harness();
  await h.service.save("UC1", { banner: { kind: "bytes", bytes: png(2560, 1440) } }, "owner");
  const version = await previewVersion(h);
  h.files.set("UC1", png(2048, 1152));
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, version), { code: "branding_changed" });
  assert.deepEqual(h.writeCalls(), []);
});

// --- AC-CB-05 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-05: banner uploaded, update fails -> banner_uploaded_not_set; the result says the old banner stays; audit shows both", async () => {
  const h = harness({ updateFails: true });
  await h.service.save("UC1", { description: "New", banner: { kind: "bytes", bytes: png(2560, 1440) } }, "owner");
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h)), (error: DomainError) => {
    assert.equal(error.code, "banner_uploaded_not_set");
    assert.match(error.message, /keeps its old banner/);
    return true;
  });
  assert.deepEqual(h.writeCalls(), ["channelBanners.insert:image/png", "channels.update:UC1"]);
  const last = JSON.parse(h.rows.get("UC1")!.lastApplyJson!) as ChannelBrandingLastApply;
  assert.equal(last.ok, false);
  assert.equal(!last.ok && last.failure, "banner_uploaded_not_set");
  assert.equal(!last.ok && last.detail, "update_failed");
  assert.equal(last.writes, 1);
  assert.deepEqual(h.events.map((e) => e.kind), ["saved", "backup", "banner_upload", "failed"]);
  assert.equal((h.events[3].detail as { bannerUrl: string }).bannerUrl, "https://yt3/new-banner");
});

test("an update failure without a banner is a plain failure (the error code), not banner_uploaded_not_set", async () => {
  const h = harness({ updateFails: true });
  await h.service.save("UC1", { description: "New" }, "owner");
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h)), { code: "update_failed" });
  const last = JSON.parse(h.rows.get("UC1")!.lastApplyJson!) as ChannelBrandingLastApply;
  assert.equal(!last.ok && last.failure, "failed");
});

// --- AC-CB-06 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-06: a wrong channel is refused before any read or write", async () => {
  const h = harness({ wrongChannel: true });
  await h.service.save("UC1", { description: "New", banner: { kind: "bytes", bytes: png(2560, 1440) } }, "owner");
  const version = await previewVersion(h);
  const readsBefore = h.calls.filter((c) => c === "channels.list").length;
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, version), { code: "WRONG_CHANNEL" });
  assert.deepEqual(h.writeCalls(), []);
  assert.equal(h.calls.filter((c) => c === "channels.list").length, readsBefore);
  await assert.rejects(h.service.apply("UC9", { userId: "user-1" }, version), { code: "channel_not_connected" });
});

test("AC-CB-06: Live writes off -> refused, no gateway write (with and without a banner)", async () => {
  for (const banner of [true, false]) {
    const h = harness({ liveWrites: false });
    await h.service.save("UC1", { description: "New", ...(banner ? { banner: { kind: "bytes" as const, bytes: png(2560, 1440) } } : {}) }, "owner");
    await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h)), { code: "live_writes_disabled" });
    assert.deepEqual(h.writeCalls(), []);
  }
});

// --- AC-CB-07 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-07: a draft saved after the preview -> branding_changed, nothing read or written; a missing version -> validation_failed", async () => {
  const h = harness();
  await h.service.save("UC1", { description: "First" }, "owner");
  const version = await previewVersion(h);
  await h.service.save("UC1", { description: "Second" }, "factory");
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, version), { code: "branding_changed" });
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, undefined), { code: "validation_failed" });
  assert.deepEqual(h.writeCalls(), []);
  assert.ok(!h.calls.includes("assertWriteChannel"));
});

test("the channel changed on YouTube between the read and the write -> update_failed, nothing sent", async () => {
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel({}, { country: "DE" })] });
  await h.service.save("UC1", { description: "New" }, "owner");
  await assert.rejects(h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h)), { code: "update_failed" });
  assert.deepEqual(h.writeCalls(), []);
});

// --- AC-CB-08 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-08: read-back shows another field changed -> ok false, read_back_mismatch naming it, backup kept", async () => {
  const after = liveChannel({}, { description: "New", country: "DE" });
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel(), after, after] });
  await h.service.save("UC1", { description: "New" }, "owner");
  const result = await h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h));
  assert.deepEqual(result, {
    at: "2026-10-25T10:00:00.000Z",
    ok: false,
    failure: "read_back_mismatch",
    detail: "other branding field changed: country",
    fields: ["description"],
    writes: 1,
    backupPath: "/backups/b1.json",
    banner: null,
  });
});

test("AC-CB-08: read-back shows a draft field differing (keywords re-ordered, banner not set) -> read_back_mismatch with both", async () => {
  const after = liveChannel({ bannerExternalUrl: "https://yt3/old-banner" }, { keywords: '"late night" lofi' });
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel(), after, after] });
  await h.service.save("UC1", { keywords: ["lofi", "late night"], banner: { kind: "bytes", bytes: png(2560, 1440) } }, "owner");
  const result = await h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h));
  assert.equal(result.ok, false);
  assert.equal(
    !result.ok && result.detail,
    'keywords differ: sent "lofi \\"late night\\"", YouTube shows "\\"late night\\" lofi"; banner not set (the channel shows another banner URL)'
  );
  assert.equal(result.backupPath, "/backups/b1.json");
  assert.equal(JSON.parse(h.rows.get("UC1")!.lastApplyJson!).failure, "read_back_mismatch");
});

test("AC-CB-08: a read-back that settles on the second read is ok (bounded re-reads)", async () => {
  const after = liveChannel({}, { description: "New" });
  const h = harness({ reads: [liveChannel(), liveChannel(), liveChannel(), liveChannel(), after] });
  await h.service.save("UC1", { description: "New" }, "owner");
  const result = await h.service.apply("UC1", { userId: "user-1" }, await previewVersion(h));
  assert.equal(result.ok, true);
});

// --- AC-CB-10 ------------------------------------------------------------------------------------------------------------------

test("AC-CB-10: get returns the draft, the live values (name and avatar included) and the last result", async () => {
  const h = harness();
  await h.service.save("UC1", { description: "New" }, "factory");
  h.rows.get("UC1")!.lastApplyJson = JSON.stringify({ at: "2026-10-24T00:00:00.000Z", ok: true, fields: ["keywords"], writes: 1, backupPath: "/b", banner: null });
  const view = await h.service.get("UC1");
  assert.deepEqual(view.draft, { description: "New" });
  assert.equal(view.updatedBy, "factory");
  assert.deepEqual(view.live, {
    title: "Tropico",
    avatarUrl: "https://yt3/avatar-800",
    customUrl: "@tropico",
    description: "Old description",
    keywords: ["lofi", "chill beats"],
    country: "US",
    defaultLanguage: "en",
    unsubscribedTrailer: "VIDEO123456",
    bannerUrl: "https://yt3/old-banner",
  });
  assert.equal(view.liveUnavailable, null);
  assert.deepEqual(view.lastApply, { at: "2026-10-24T00:00:00.000Z", ok: true, fields: ["keywords"], writes: 1, backupPath: "/b", banner: null });
});

test("AC-CB-10: when YouTube cannot be read, get still answers the draft with live null and the code", async () => {
  const h = harness();
  h.deps.youtube.read = async () => {
    throw new DomainError({ code: "data_api_reads_disabled" as never, message: "off" });
  };
  const view = await h.service.get("UC1");
  assert.equal(view.live, null);
  assert.equal(view.liveUnavailable, "data_api_reads_disabled");
});
