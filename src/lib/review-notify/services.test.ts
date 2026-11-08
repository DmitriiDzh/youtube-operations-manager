import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { PlanReviewEntry, PlanReviewFeed, ReviewDecisionNotice, ReviewLedgerEntry, ReviewNotifyPorts } from "./contracts";
import { createReviewNotify } from "./services";

// BL-248 (docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md). Expected names and pass ids are written out by hand from §4; a pass id is the
// SHA-256 of the hand-written sorted entry ids (node:crypto here, never the module's own function).

const T = (iso: string) => new Date(iso);
const INBOX = "/ws/00 YT Producer/Inbox";

function clipNotice(over: Partial<ReviewDecisionNotice> = {}): ReviewDecisionNotice {
  return {
    kind: "clip",
    channelId: "UCa2amtpeOmgP-HkiLKPm1gg",
    channelName: "Tropico Jazz",
    itemId: "c1a2b3c4d5e6f7a8",
    decisionId: "d000000000000001",
    status: "returned",
    comment: "Слишком тёмно в конце.\nПеределать свет.",
    decidedAt: "2026-11-08T09:30:00.000Z",
    decidedOn: "Mac",
    context: [{ label: "Scene", value: "Tobacco Field Barn" }],
    attachments: ["99 Data Exchange/From YTM/clip-reviews/c1a2b3c4d5e6f7a8/d000000000000001/frame.png"],
    ytmPlace: "Медиа → «Клипы»",
    readTool: "producer_clip_review_get c1a2b3c4d5e6f7a8",
    ...over,
  };
}

function verdict(planId: string, itemKey: string, attemptRef: string, at: string, result: "accepted" | "rejected", over: Partial<PlanReviewEntry> = {}): PlanReviewEntry {
  return { entryId: `v|${planId}|${itemKey}|${attemptRef}|${at}|${result}`, type: "verdict", itemKey, attemptRef, groupId: "w1", at, device: "Mac", result, rating: 7, reasons: [], marks: [], note: null, ...over };
}

function harness(opts: { enabled?: boolean | null; producerFolder?: boolean; inboxThere?: boolean; now: string; singles?: ReviewDecisionNotice[]; plans?: PlanReviewFeed[]; failingSource?: boolean; platform?: string }) {
  const files = new Map<string, string>();
  const ledger = new Map<string, ReviewLedgerEntry>();
  const store = { settings: opts.enabled === undefined || opts.enabled === null ? null : JSON.stringify({ enabled: opts.enabled, inboxPath: null }), state: null as string | null };
  const clock = { now: T(opts.now) };
  const logs: string[] = [];
  const env = { singles: opts.singles ?? [], plans: opts.plans ?? [], inboxThere: opts.inboxThere ?? true, producerFolder: opts.producerFolder ?? true, platform: opts.platform ?? "darwin", sweeps: 0, singlesErrors: [] as string[], failWrite: false, onWrite: null as null | (() => Promise<void>) };
  const writes: string[] = [];
  const ports: ReviewNotifyPorts = {
    decisionSources: [
      ...(opts.failingSource ? [{ name: "broken", list: async () => Promise.reject(new Error("document unreadable")) }] : []),
      { name: "singles", list: async () => (env.singlesErrors.length > 0 ? { items: env.singles, errors: env.singlesErrors } : env.singles) },
    ],
    planSources: [{ name: "plans", list: async () => env.plans }],
    settings: { read: async () => store.settings, write: async (json) => void (store.settings = json) },
    state: { read: async () => store.state, write: async (json) => void (store.state = json) },
    ledger: {
      has: async (keys) => new Set(keys.filter((k) => ledger.has(k))),
      record: async (entries) => entries.forEach((e) => ledger.set(e.key, e)),
      prune: async () => undefined,
    },
    inbox: {
      defaultPath: async () => INBOX,
      producerFolderExists: async () => env.producerFolder,
      isDirectory: async () => env.inboxThere,
      async writeOnce(dir, name, content) {
        writes.push(name);
        if (env.onWrite) await env.onWrite();
        if (env.failWrite) throw new Error("crash mid-write");
        const key = `${dir}/${name}`;
        if (files.has(key)) return "exists";
        files.set(key, content);
        return "written";
      },
      sweepTemp: async () => {
        env.sweeps++;
        return 0;
      },
    },
    platform: () => env.platform,
    now: () => clock.now,
    log: (event, context) => logs.push(`${event} ${JSON.stringify(context)}`),
  };
  return { core: createReviewNotify(ports), files, ledger, store, clock, logs, env, writes, names: () => [...files.keys()].map((k) => k.slice(INBOX.length + 1)).sort() };
}

test("AC-RN-01/05: one owner decision gives exactly one file; a second tick and a fresh service on the same ledger write nothing", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()] });
  const first = await h.core.tick();
  assert.deepEqual(first.written, ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md"]);
  assert.deepEqual(h.names(), ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md"]);
  assert.deepEqual((await h.core.tick()).written, []);
  // The Producer moved the file away: the ledger still says it was written, so it is not written again.
  h.files.clear();
  assert.deepEqual((await h.core.tick()).written, []);
  assert.deepEqual(h.names(), []);
});

test("AC-RN-01: the file carries the status, the comment verbatim and the attachment paths", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()] });
  await h.core.tick();
  const content = [...h.files.values()][0];
  assert.match(content, /^---\nformat: "ytm-review-decision\/1"\nkind: "clip"\nchannelId: "UCa2amtpeOmgP-HkiLKPm1gg"\nitemId: "c1a2b3c4d5e6f7a8"\ndecisionId: "d000000000000001"\nstatus: "returned"\ndecidedAt: "2026-11-08T09:30:00.000Z"\ndecidedOn: "Mac"\n---\n/);
  assert.ok(content.includes("```text\nСлишком тёмно в конце.\nПеределать свет.\n```"));
  assert.ok(content.includes("- `99 Data Exchange/From YTM/clip-reviews/c1a2b3c4d5e6f7a8/d000000000000001/frame.png`"));
  assert.ok(content.includes("- Scene: Tobacco Field Barn"));
  assert.ok(content.includes("`producer_clip_review_get c1a2b3c4d5e6f7a8`"));
  assert.ok(content.includes("Tropico Jazz"));
});

test("AC-RN-06: an existing file with the final name counts as notified and is not rewritten", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()] });
  h.files.set(`${INBOX}/REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md`, "the Producer's own copy");
  const result = await h.core.tick();
  assert.deepEqual(result.written, []);
  assert.equal(h.files.get(`${INBOX}/REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md`), "the Producer's own copy");
  assert.ok(h.ledger.has("clip|UCa2amtpeOmgP-HkiLKPm1gg|c1a2b3c4d5e6f7a8|d000000000000001"));
});

test("AC-RN-10: a missing Inbox writes and records nothing, logs once; the folder back -> the files come", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], inboxThere: false });
  const first = await h.core.tick();
  assert.deepEqual(first.written, []);
  assert.equal(first.errors.length, 1);
  assert.equal(h.ledger.size, 0);
  await h.core.tick();
  assert.equal(h.logs.length, 1, "the same failure is logged once");
  assert.match((await h.core.view()).lastError ?? "", /Inbox folder is not there/);
  h.env.inboxThere = true;
  assert.deepEqual((await h.core.tick()).written, ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md"]);
});

test("AC-RN-11: switch off -> nothing read into files, nothing recorded", async () => {
  const h = harness({ enabled: false, now: "2026-11-08T09:31:00Z", singles: [clipNotice()] });
  const result = await h.core.tick();
  assert.equal(result.ran, false);
  assert.deepEqual(h.writes, []);
  assert.equal(h.ledger.size, 0);
});

test("AC-RN-15: never set -> on when 00 YT Producer is here, off when not; the owner's choice wins", async () => {
  const here = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: true });
  assert.equal((await here.core.view()).enabled, true);
  assert.equal((await here.core.tick()).written.length, 1);
  const absent = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: false });
  assert.equal((await absent.core.view()).enabled, false);
  assert.equal((await absent.core.tick()).ran, false);
  const forced = harness({ enabled: true, now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: false });
  assert.equal((await forced.core.tick()).written.length, 1);
  const refused = harness({ enabled: false, now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: true });
  assert.equal((await refused.core.tick()).ran, false);
});

test("AC-RN-12: first enable backfills single decisions from 2026-11-08T00:00:00Z, plans only from the enable time", async () => {
  const before = clipNotice({ itemId: "aaaaaaaaaaaaaaaa", decisionId: "b000000000000001", decidedAt: "2026-11-07T23:59:59.000Z" });
  const atCutoff = clipNotice({ itemId: "aaaaaaaaaaaaaaaa", decisionId: "b000000000000002", decidedAt: "2026-11-08T00:00:00.000Z" });
  const plan: PlanReviewFeed = {
    planId: "plan-1",
    channelId: "UCx",
    channelName: null,
    title: "Scenes",
    video: null,
    entries: [verdict("plan-1", "i1", "a1", "2026-11-08T11:00:00.000Z", "accepted")],
    waveFinishedAt: ["2026-11-08T11:00:00.000Z"],
    ytmPlace: "x",
    readTool: "factory_plan_get plan-1",
  };
  const h = harness({ now: "2026-11-08T12:00:00Z", singles: [before, atCutoff], plans: [plan] });
  const result = await h.core.tick();
  assert.deepEqual(result.written, ["REVIEW-DECISION-clip-aaaaaaaaaaaaaaaa-b000000000000002.md"]);
  // A verdict after the enable time is written.
  h.clock.now = T("2026-11-08T12:10:00Z");
  h.env.plans = [{ ...plan, entries: [...plan.entries, verdict("plan-1", "i2", "a1", "2026-11-08T12:01:00.000Z", "rejected")] }];
  const second = await h.core.tick();
  const expected = createHash("sha256").update("v|plan-1|i2|a1|2026-11-08T12:01:00.000Z|rejected", "utf8").digest("hex").slice(0, 16);
  assert.deepEqual(second.written, [`REVIEW-DECISION-plan-plan-1-${expected}.md`]);
});

test("§6: turned off and on again later -> no second backfill, single decisions only from the new enable", async () => {
  const h = harness({ enabled: true, now: "2026-11-08T09:00:00Z", singles: [] });
  await h.core.tick();
  h.store.settings = JSON.stringify({ enabled: false, inboxPath: null });
  h.clock.now = T("2026-11-08T10:00:00Z");
  await h.core.tick();
  const whileOff = clipNotice({ decisionId: "e000000000000001", decidedAt: "2026-11-08T10:30:00.000Z" });
  h.env.singles = [whileOff];
  h.store.settings = JSON.stringify({ enabled: true, inboxPath: null });
  h.clock.now = T("2026-11-08T11:00:00Z");
  assert.deepEqual((await h.core.tick()).written, []);
  h.env.singles = [whileOff, clipNotice({ decisionId: "e000000000000002", decidedAt: "2026-11-08T11:30:00.000Z" })];
  h.clock.now = T("2026-11-08T11:31:00Z");
  assert.deepEqual((await h.core.tick()).written, ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-e000000000000002.md"]);
});

test("AC-RN-07/08: plan entries wait for 5 quiet minutes, then one file lists them all; the next verdict is the next pass", async () => {
  const e1 = verdict("plan-7", "img-01", "a1", "2026-11-08T10:00:00.000Z", "accepted", { rating: 8, reasons: ["свет"], marks: [{ start: 0, end: null, note: "небо", region: { x: 0.2, y: 0.3, r: 0.1 } }], note: "Хорошо" });
  const e2 = verdict("plan-7", "img-02", "a1", "2026-11-08T10:01:00.000Z", "rejected", { note: "Слишком ярко" });
  const feed: PlanReviewFeed = { planId: "plan-7", channelId: "UCx", channelName: "Japan", title: "Stills", video: "V61", entries: [e1, e2], waveFinishedAt: [], ytmPlace: "Медиа → «Картинки»", readTool: "factory_plan_get plan-7" };
  const h = harness({ now: "2026-11-08T09:59:00Z", plans: [] });
  await h.core.tick(); // enables at 09:59
  h.env.plans = [feed];
  h.clock.now = T("2026-11-08T10:03:00Z"); // newest is 2 minutes old
  assert.deepEqual((await h.core.tick()).written, []);
  h.clock.now = T("2026-11-08T10:06:00Z"); // 5 minutes after the newest
  const expectedId = createHash("sha256")
    .update(["v|plan-7|img-01|a1|2026-11-08T10:00:00.000Z|accepted", "v|plan-7|img-02|a1|2026-11-08T10:01:00.000Z|rejected"].join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16);
  assert.deepEqual((await h.core.tick()).written, [`REVIEW-DECISION-plan-plan-7-${expectedId}.md`]);
  const content = [...h.files.values()][0];
  assert.ok(content.includes("entries: 2"));
  assert.ok(content.includes("- Rating: 8/10"));
  assert.ok(content.includes("0s region x=0.2 y=0.3 r=0.1: небо"));
  assert.ok(content.includes("```text\nСлишком ярко\n```"));
  assert.ok(content.includes("- Video: V61"));

  const e3 = verdict("plan-7", "img-03", "a2", "2026-11-08T10:10:00.000Z", "accepted");
  h.env.plans = [{ ...feed, entries: [e1, e2, e3], waveFinishedAt: ["2026-11-08T10:10:00.000Z"] }];
  h.clock.now = T("2026-11-08T10:10:30Z");
  const nextId = createHash("sha256").update("v|plan-7|img-03|a2|2026-11-08T10:10:00.000Z|accepted", "utf8").digest("hex").slice(0, 16);
  assert.deepEqual((await h.core.tick()).written, [`REVIEW-DECISION-plan-plan-7-${nextId}.md`], "a finished wave writes at once, only the new entry");
  assert.equal(h.files.size, 2);
});

test("AC-RN-07: a wave finished before the pass's earliest entry does not count; one after it does", async () => {
  const h = harness({ now: "2026-11-08T09:00:00Z" });
  await h.core.tick();
  const entry = verdict("p", "i", "a", "2026-11-08T10:00:00.000Z", "accepted");
  h.env.plans = [{ planId: "p", channelId: "UCx", channelName: null, title: null, video: null, entries: [entry], waveFinishedAt: ["2026-11-08T09:50:00.000Z"], ytmPlace: "x", readTool: "y" }];
  h.clock.now = T("2026-11-08T10:01:00Z");
  assert.deepEqual((await h.core.tick()).written, []);
  // A `group_reviewed` stamped one second before the verdict (one-second resolution) counts.
  h.env.plans = [{ ...h.env.plans[0], waveFinishedAt: ["2026-11-08T09:59:59.000Z"] }];
  assert.equal((await h.core.tick()).written.length, 1);
});

test("AC-RN-17: a broken source is reported and the others' files are still written", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], failingSource: true });
  const result = await h.core.tick();
  assert.equal(result.written.length, 1);
  assert.deepEqual(result.errors, ["broken: document unreadable"]);
});

test("the same plan from two sources (this computer's verdicts and the owning computer's report) is merged, entries once", async () => {
  const entry = verdict("p2", "i", "a", "2026-11-08T10:00:00.000Z", "accepted");
  const feed: PlanReviewFeed = { planId: "p2", channelId: "UCx", channelName: null, title: "T", video: null, entries: [entry], waveFinishedAt: [], ytmPlace: "x", readTool: "y" };
  const h = harness({ now: "2026-11-08T09:00:00Z" });
  await h.core.tick();
  h.env.plans = [feed, { ...feed, title: null }];
  h.clock.now = T("2026-11-08T10:06:00Z");
  const result = await h.core.tick();
  assert.equal(result.written.length, 1);
  assert.ok([...h.files.values()][0].includes("entries: 1"));
});

test("settings: a field left out keeps its value; a relative Inbox path is refused", async () => {
  const h = harness({ now: "2026-11-08T09:00:00Z" });
  const view = await h.core.updateSettings({ enabled: false });
  assert.equal(view.enabledSetting, false);
  assert.equal((await h.core.updateSettings({ inboxPath: "/Volumes/X/Inbox" })).enabledSetting, false);
  await assert.rejects(() => h.core.updateSettings({ inboxPath: "relative/Inbox" }), (error: { code?: string; details?: unknown }) => error.code === "validation_failed" && JSON.stringify(error.details).includes("absolute path"));
  await assert.rejects(() => h.core.updateSettings({ extra: 1 }));
  assert.equal((await h.core.updateSettings({ enabled: null })).enabled, true, "back to the default (folder present)");
});

test("§6/§8: a default-on writer whose disk goes away keeps waiting (Inbox missing), and writes the decisions made meanwhile", async () => {
  const h = harness({ now: "2026-11-08T09:00:00Z", producerFolder: true });
  assert.equal((await h.core.tick()).ran, true);
  // The disk (both the Producer folder and its Inbox) is away; the owner decides meanwhile.
  h.env.producerFolder = false;
  h.env.inboxThere = false;
  h.env.singles = [clipNotice({ decisionId: "f000000000000001", decidedAt: "2026-11-08T09:10:00.000Z" })];
  h.clock.now = T("2026-11-08T09:11:00Z");
  const away = await h.core.tick();
  assert.equal(away.ran, true, "still on: the default does not turn off while the folder is away");
  assert.equal(away.errors.length, 1);
  assert.equal(h.ledger.size, 0);
  assert.equal(JSON.parse(h.store.state ?? "{}").activeSince, "2026-11-08T09:00:00.000Z");
  h.env.producerFolder = true;
  h.env.inboxThere = true;
  h.clock.now = T("2026-11-08T09:20:00Z");
  assert.deepEqual((await h.core.tick()).written, ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-f000000000000001.md"]);
});

test("§9: a nudge never throws into the owner's decision, even when the registered loop throws", async () => {
  const { registerReviewNotifyNudge, nudgeReviewNotify } = await import("./index");
  nudgeReviewNotify(); // nothing registered: nothing happens
  registerReviewNotifyNudge(() => {
    throw new Error("broken loop");
  });
  assert.doesNotThrow(() => nudgeReviewNotify());
  registerReviewNotifyNudge(null);
});

test("B1: the default is on only on macOS with the Producer folder; another platform with the folder is off and never sticky", async () => {
  const win = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: true, platform: "win32" });
  assert.equal((await win.core.view()).enabled, false);
  assert.equal((await win.core.view()).defaultEnabled, false);
  assert.equal((await win.core.tick()).ran, false);
  assert.deepEqual(win.writes, []);
  const mac = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()], producerFolder: true, platform: "darwin" });
  assert.equal((await mac.core.view()).defaultEnabled, true);
  assert.equal((await mac.core.tick()).written.length, 1);
  // Owner turned Windows on explicitly, then back to the default: off again (its default was never on, so nothing sticks).
  await win.core.updateSettings({ enabled: true });
  assert.equal((await win.core.tick()).ran, true);
  await win.core.updateSettings({ enabled: null });
  assert.equal((await win.core.tick()).ran, false);
});

test("B2: the card shows the effective state -- on and waiting while the folder of a default-on Mac is away", async () => {
  const h = harness({ now: "2026-11-08T09:00:00Z", producerFolder: true });
  await h.core.tick();
  h.env.producerFolder = false;
  h.env.inboxThere = false;
  const view = await h.core.view();
  assert.equal(view.enabled, true);
  assert.equal(view.defaultEnabled, false);
  assert.equal(view.waitingForFolder, true);
  assert.equal(view.enabledSetting, null);
});

test("N10: while off, no old error is kept or shown", async () => {
  const h = harness({ now: "2026-11-08T09:00:00Z", inboxThere: false });
  await h.core.tick();
  assert.ok((await h.core.view()).lastError);
  await h.core.updateSettings({ enabled: false });
  assert.equal((await h.core.view()).lastError, null);
  await h.core.tick();
  assert.equal(JSON.parse(h.store.state ?? "{}").lastError, null);
});

test("N8: a damaged stored floor never throws: it falls back to the enable time", async () => {
  const h = harness({ now: "2026-11-08T12:00:00Z", singles: [clipNotice({ decidedAt: "2026-11-08T11:00:00.000Z" }), clipNotice({ decisionId: "d000000000000009", decidedAt: "2026-11-08T09:00:00.000Z" })] });
  h.store.state = JSON.stringify({ activeSince: "2026-11-08T10:00:00.000Z", singlesFloor: "not a time", backfillDone: true, defaultOnSeen: true });
  const result = await h.core.tick();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.written, ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md"]);
});

test("N9: a tick asked for while one runs gives one more run right after it", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z" });
  await h.core.tick();
  let release: () => void = () => undefined;
  h.env.singles = [clipNotice()];
  h.env.onWrite = () => new Promise<void>((resolve) => (release = resolve));
  const first = h.core.tick();
  await new Promise((r) => setTimeout(r, 10));
  // A decision recorded mid-run, and its nudge.
  h.env.singles = [clipNotice(), clipNotice({ decisionId: "d000000000000002" })];
  h.env.onWrite = null;
  const second = h.core.tick();
  release();
  await first;
  await second;
  assert.deepEqual(h.names(), ["REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000001.md", "REVIEW-DECISION-clip-c1a2b3c4d5e6f7a8-d000000000000002.md"]);
});

test("N2: a source's per-channel errors are reported while its other items are written", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z", singles: [clipNotice()] });
  h.env.singlesErrors = ["UCbroken: document unreadable"];
  const result = await h.core.tick();
  assert.equal(result.written.length, 1);
  assert.deepEqual(result.errors, ["singles: UCbroken: document unreadable"]);
});

test("N5: temporary files are swept at the start of every run with the Inbox there", async () => {
  const h = harness({ now: "2026-11-08T09:31:00Z" });
  await h.core.tick();
  await h.core.tick();
  assert.equal(h.env.sweeps, 2);
});

test("N6: a pass interrupted after its file was started is finished as exactly that pass, never a second file with its entries", async () => {
  const e1 = verdict("p6", "i1", "a", "2026-11-08T10:00:00.000Z", "accepted");
  const feed: PlanReviewFeed = { planId: "p6", channelId: "UCx", channelName: null, title: "T", video: null, entries: [e1], waveFinishedAt: [], ytmPlace: "x", readTool: "y" };
  const h = harness({ now: "2026-11-08T09:00:00Z" });
  await h.core.tick();
  h.env.plans = [feed];
  h.clock.now = T("2026-11-08T10:06:00Z");
  h.env.failWrite = true;
  await h.core.tick();
  assert.deepEqual(JSON.parse(h.store.state ?? "{}").pendingPasses, { p6: [e1.entryId] });
  // A new verdict arrives before the retry: the interrupted pass is written alone, the new one waits for its own pass.
  const e2 = verdict("p6", "i2", "a", "2026-11-08T10:07:00.000Z", "rejected");
  h.env.plans = [{ ...feed, entries: [e1, e2] }];
  h.env.failWrite = false;
  h.clock.now = T("2026-11-08T10:08:00Z");
  const result = await h.core.tick();
  const onlyFirst = createHash("sha256").update(e1.entryId, "utf8").digest("hex").slice(0, 16);
  assert.deepEqual(result.written, [`REVIEW-DECISION-plan-p6-${onlyFirst}.md`]);
  assert.deepEqual(JSON.parse(h.store.state ?? "{}").pendingPasses, {});
});

test("N1: the same verdict seen first among this computer's sent verdicts, then in the owning computer's report, is written once", async () => {
  const id = "v|pw|i|a|2026-11-08T10:00:00Z|accepted";
  const sent: PlanReviewFeed = { planId: "pw", channelId: "UCx", channelName: null, title: "W", video: null, entries: [verdict("pw", "i", "a", "2026-11-08T10:00:00.000Z", "accepted", { entryId: id })], waveFinishedAt: [], ytmPlace: "x", readTool: "y" };
  const h = harness({ now: "2026-11-08T09:00:00Z" });
  await h.core.tick();
  h.env.plans = [sent];
  h.clock.now = T("2026-11-08T10:06:00Z");
  assert.equal((await h.core.tick()).written.length, 1);
  h.env.plans = [{ ...sent, entries: [verdict("pw", "i", "a", "2026-11-08T10:00:00Z", "accepted", { entryId: id, device: "Win" })], waveFinishedAt: ["2026-11-08T10:00:01Z"] }];
  h.clock.now = T("2026-11-08T10:20:00Z");
  assert.deepEqual((await h.core.tick()).written, []);
});
