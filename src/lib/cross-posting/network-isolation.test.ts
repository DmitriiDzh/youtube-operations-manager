import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { MetaPage, MetaTokenInspection } from "@/lib/social-gateway";
import { createCrossPostingServices, createCrossPostRunner, type CrossPostingStore, type PlannedCrossPost, type SocialAccountRow, type SocialJob } from "./index";
import { jobIdOf, MAX_LATE_MS, type RunnerDeps } from "./runner";

// 2026-11-23, owner TG 4779 (approved): «перестроить эту систему так чтобы даже если одна из соц сетей отваливалась — оставшиеся
// продолжали обновляться и получать свои публикации». Acceptance criteria (the coordinator's, from that requirement), with the
// expected outcomes written by hand:
//  1. Facebook needs a valid Page token, Facebook's scopes and the same live Page; Instagram needs all of that plus its own scopes
//     and the same live linked account. A wrong Page or a wrong Instagram never gets a post.
//  2. An Instagram-only problem (unlinked, mismatch, its scope, its quota, its upload error, its missed window, anything) never
//     blocks Facebook, for the same slot or later ones -- and the reverse where possible.
//  3. `token_invalid` / `page_mismatch` (the shared Page token) fail both; each job records its own network's real code.
//  4. One network throwing, hanging or being refused never aborts, skips or delays the other in the runner.
//  6. The account check reports per network.  7. A reconnect while Instagram is gone keeps Facebook posting.
// The real services and the real runner are wired together as `src/composition/cross-posting-runner.ts` does (postingTarget,
// quotaAllows), with Meta faked: no real Meta call.

const APP = { appId: "1234567890", appSecret: "0123456789abcdef0123456789abcdef" };
const REDIRECT = "https://mac.tail.ts.net/api/social/meta/callback";
const ALL_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"];
const HEALTHY: MetaTokenInspection = { valid: true, scopes: ALL_SCOPES, expiresAt: null, page: { pageId: "111", pageName: "WWE" }, instagram: { igUserId: "1784", username: "wwexplained" } };
const PAGE_WITH_IG: MetaPage = { pageId: "111", pageName: "WWE", pageToken: "PAGE-TOKEN", instagram: { igUserId: "1784", username: "wwexplained", pictureUrl: null } };
const T0 = Date.parse("2026-11-20T12:00:00Z");

const slot = (slotId: string, publishAt: number, over: Partial<PlannedCrossPost> = {}): PlannedCrossPost => ({
  channelId: "UC1",
  slotId,
  video: slotId.toUpperCase(),
  manifestSha256: `m-${slotId}`,
  publishAt,
  slotDate: new Date(publishAt).toISOString().slice(0, 10),
  timeZone: "UTC",
  crossPost: { instagram: { caption: "IG" }, facebook: { title: "T", description: "FB" } },
  videoFile: { path: `/w/${slotId}.mp4`, sizeBytes: 1000, durationSeconds: 30, width: 1080, height: 1920 },
  videoSha256: "a".repeat(64),
  isAiGenerated: false,
  ...over,
});

type Hold = { release: () => void };

async function world(opts: { entries?: PlannedCrossPost[]; igUsage?: () => Promise<number | null> } = {}) {
  let now = T0;
  let inspection: MetaTokenInspection = HEALTHY;
  let pages: MetaPage[] = [PAGE_WITH_IG];
  const rows: SocialAccountRow[] = [];
  const jobs = new Map<string, SocialJob>();
  const calls: string[] = [];
  const failOn = new Map<string, unknown>();
  const holds = new Map<string, Hold>();
  let n = 0;
  const store: CrossPostingStore = {
    channelExists: async (id) => id === "UC1",
    list: async (id) => rows.filter((r) => id === null || r.channelId === id),
    upsert: async (row) => {
      const i = rows.findIndex((r) => r.channelId === row.channelId && r.network === row.network);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    remove: async (id, network) => {
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].channelId !== id || (network !== null && rows[i].network !== network)) continue;
        rows.splice(i, 1);
        removed++;
      }
      return removed;
    },
  };
  let secret: string | null = null;
  const core = createCrossPostingServices({
    store,
    appSecret: {
      read: async () => secret,
      write: async (plaintext, input) => ((secret = plaintext), { hints: input.hints, status: null, verifiedAt: null, updatedAt: now, version: "v" }),
      clear: async () => void (secret = null),
      info: async () => (secret ? { hints: {}, status: null, verifiedAt: null, updatedAt: now, version: "v" } : null),
    },
    sealer: { seal: async (p) => ({ ciphertext: Buffer.from(`sealed:${p}`).toString("base64"), iv: "iv", authTag: "tag" }), open: async (p) => Buffer.from(p.ciphertext, "base64").toString().replace(/^sealed:/, "") },
    meta: {
      authorizeUrl: ({ state }) => `https://meta.test/dialog?state=${state}`,
      exchangeCode: async () => ({ userToken: "USER", expiresAt: null }),
      listPages: async () => pages,
      inspectPageToken: async () => inspection,
      igPublishingUsage: opts.igUsage ?? (async () => 0),
    },
    jobs: { list: async (id) => [...jobs.values()].filter((j) => id === null || j.channelId === id), get: async (id) => jobs.get(id) ?? null, update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }) },
    now: () => now,
    randomId: () => `random-id-${String(++n).padStart(8, "0")}`,
  });
  const connect = async () => {
    const state = new URL((await core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl).searchParams.get("state");
    const { pickId } = await core.completeConnect({ state, code: "C", redirectUri: REDIRECT });
    return core.selectPage({ pickId, pageId: "111" });
  };
  await core.setMetaApp(APP);
  await connect();

  const call = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (holds.has(name)) await new Promise<void>((resolve) => holds.set(name, { release: resolve }));
    if (failOn.has(name)) throw failOn.get(name);
    return value;
  };
  const meta: RunnerDeps["meta"] = {
    igCreateReelContainer: (i) => call(`ig.container ${i.igUserId}`, { containerId: "C1" }),
    igUploadReel: () => call("ig.upload", undefined),
    igContainerStatus: () => call("ig.status", "FINISHED"),
    igPublish: (i) => call(`ig.publish ${i.igUserId}`, { mediaId: "M1" }),
    igPermalink: () => call("ig.permalink", "https://instagram.com/reel/M1"),
    fbReelStart: (i) => call(`fb.start ${i.pageId}`, { videoId: "V1", uploadUrl: "https://rupload.facebook.com/video-upload/v23.0/V1" }),
    fbUploadReel: () => call("fb.upload", undefined),
    fbReelFinish: (i) => call(`fb.finish ${i.pageId}`, undefined),
    fbVideoStatus: () => call("fb.status", { videoStatus: "ready", publishStatus: "published", permalink: "https://facebook.com/reel/V1" }),
  };
  const entries = opts.entries ?? [slot("s6", T0)];
  const runner = createCrossPostRunner({
    plan: { entries: async () => entries, stillApproved: async () => true },
    jobs: {
      get: async (id) => (jobs.has(id) ? { ...jobs.get(id)! } : null),
      listActive: async () => [...jobs.values()].filter((j) => j.status === "uploading" || j.status === "processing").map((j) => ({ ...j })),
      insert: async (job) => (jobs.has(job.jobId) ? false : (jobs.set(job.jobId, { ...job }), true)),
      update: async (id, set) => void jobs.set(id, { ...jobs.get(id)!, ...set }),
    },
    // As the composition wires them:
    postingTarget: (channelId, network) => core.postingTarget(channelId, network),
    quotaOk: (channelId, network) => core.quotaAllows(channelId, network),
    meta,
    files: { body: (_p, size) => ({ stream: () => new Blob(["x"]).stream(), sizeBytes: size }), sha256: async () => "a".repeat(64) },
    enabled: async () => true,
    now: () => now,
  });
  return {
    core,
    runner,
    rows,
    jobs,
    calls,
    failOn,
    holds,
    connect,
    setInspection: (i: MetaTokenInspection) => (inspection = i),
    setPages: (p: MetaPage[]) => (pages = p),
    at: (ms: number) => (now = ms),
    job: (slotId: string, network: "facebook" | "instagram") => jobs.get(jobIdOf("UC1", slotId, network)),
    /** Two passes: the first uploads and calls finish, the second reads Facebook's status back to `published`. */
    run: async () => {
      await runner.tick();
      await runner.tick();
    },
  };
}

const isMismatch = (problem: string) => (e: unknown) => e instanceof DomainError && e.code === "social_account_mismatch" && (e.details as { problems?: string[] }).problems?.[0] === problem;
const noIgCall = (calls: string[]) => !calls.some((c) => c.startsWith("ig."));
const noPostingCall = (calls: string[]) => calls.length === 0;

// ----- criterion 1 / 6: the account check, per network -----

test("check: Instagram unlinked -> Facebook OK, Instagram instagram_unlinked; the Facebook target is served, the Instagram one refused", async () => {
  const w = await world();
  w.setInspection({ ...HEALTHY, instagram: null });
  const check = await w.core.checkAccounts("UC1");
  assert.deepEqual(
    check.networks.map((n) => [n.network, n.ok, n.problems, n.stored, n.live]),
    [
      ["facebook", true, [], "111", "111"],
      ["instagram", false, ["instagram_unlinked"], "1784", null],
    ],
  );
  assert.deepEqual(await w.core.postingTarget("UC1", "facebook"), { network: "facebook", token: "PAGE-TOKEN", pageId: "111", accountId: "111" });
  await assert.rejects(w.core.postingTarget("UC1", "instagram"), isMismatch("instagram_unlinked"));
  assert.ok(!JSON.stringify(check).includes("PAGE-TOKEN"));
});

test("check: each problem lands on the networks it concerns", async () => {
  const cases: Array<[string, MetaTokenInspection, Record<"facebook" | "instagram", string[]>, Record<"facebook" | "instagram", string[]>]> = [
    ["Instagram mismatch", { ...HEALTHY, instagram: { igUserId: "999", username: "other" } }, { facebook: [], instagram: ["instagram_mismatch"] }, { facebook: [], instagram: [] }],
    ["Instagram scope only", { ...HEALTHY, scopes: ALL_SCOPES.filter((s) => s !== "instagram_content_publish") }, { facebook: [], instagram: ["scope_missing"] }, { facebook: [], instagram: ["instagram_content_publish"] }],
    ["Instagram read refused by Meta", { ...HEALTHY, instagram: null, instagramUnreadable: true }, { facebook: [], instagram: ["instagram_unreadable"] }, { facebook: [], instagram: [] }],
    // Instagram publishes with the Page's token, so a Page scope is missing for both.
    ["Page scope", { ...HEALTHY, scopes: ALL_SCOPES.filter((s) => s !== "pages_manage_posts") }, { facebook: ["scope_missing"], instagram: ["scope_missing"] }, { facebook: ["pages_manage_posts"], instagram: ["pages_manage_posts"] }],
    ["token invalid", { valid: false, scopes: [], expiresAt: null, page: null, instagram: null }, { facebook: ["token_invalid"], instagram: ["token_invalid"] }, { facebook: [], instagram: [] }],
    ["another Page", { ...HEALTHY, page: { pageId: "222", pageName: "Other" } }, { facebook: ["page_mismatch"], instagram: ["page_mismatch"] }, { facebook: [], instagram: [] }],
  ];
  for (const [name, inspection, problems, missing] of cases) {
    const w = await world();
    w.setInspection(inspection);
    const check = await w.core.checkAccounts("UC1");
    for (const n of check.networks) {
      assert.deepEqual(n.problems, problems[n.network], `${name}: ${n.network}`);
      assert.deepEqual(n.missingScopes, missing[n.network], `${name}: ${n.network} scopes`);
      assert.equal(n.ok, problems[n.network].length === 0, `${name}: ${n.network} ok`);
    }
    assert.equal(check.ok, false, `${name}: the union says not everything passes`);
  }
});

// ----- criterion 7: reconnecting while Instagram is gone -----

test("reconnect while Instagram is gone: the Instagram row is removed, Facebook keeps its target, Instagram is not_connected", async () => {
  const w = await world();
  w.setPages([{ ...PAGE_WITH_IG, instagram: null }]);
  w.setInspection({ ...HEALTHY, instagram: null });
  const accounts = await w.connect();
  assert.deepEqual(accounts.map((a) => [a.network, a.externalId]), [["facebook", "111"]]);
  const check = await w.core.checkAccounts("UC1");
  assert.deepEqual(check.networks.map((n) => [n.network, n.ok]), [["facebook", true]]);
  assert.equal(check.ok, true);
  assert.equal((await w.core.postingTarget("UC1", "facebook")).pageId, "111");
  await assert.rejects(w.core.postingTarget("UC1", "instagram"), isMismatch("not_connected"));
});

test("quota is per network: Instagram's count unknown makes only Instagram wait", async () => {
  const w = await world({ igUsage: async () => null });
  assert.equal(await w.core.quotaAllows("UC1", "instagram"), false);
  assert.equal(await w.core.quotaAllows("UC1", "facebook"), true);
});

// ----- criteria 2 / 3: the runner with the real services -----

test("runner: Instagram unlinked -> Facebook published, Instagram failed instagram_unlinked, no Instagram call", async () => {
  const w = await world();
  w.setInspection({ ...HEALTHY, instagram: null });
  await w.run();
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "facebook")!.permalink, "https://facebook.com/reel/V1");
  assert.equal(w.job("s6", "instagram")!.status, "failed");
  assert.equal(w.job("s6", "instagram")!.errorCode, "instagram_unlinked");
  assert.ok(noIgCall(w.calls));
  assert.ok(w.calls.includes("fb.finish 111"));
});

test("runner: Instagram mismatch -> Facebook published, Instagram failed instagram_mismatch, nothing posted to the other account", async () => {
  const w = await world();
  w.setInspection({ ...HEALTHY, instagram: { igUserId: "999", username: "other" } });
  await w.run();
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "instagram")!.errorCode, "instagram_mismatch");
  assert.ok(noIgCall(w.calls));
});

test("runner: only an Instagram scope missing -> Facebook published, Instagram failed scope_missing", async () => {
  const w = await world();
  w.setInspection({ ...HEALTHY, scopes: ALL_SCOPES.filter((s) => s !== "instagram_basic") });
  await w.run();
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "instagram")!.errorCode, "scope_missing");
});

test("runner: Instagram's upload refused (ProcessingFailedError) -> Facebook still published", async () => {
  const w = await world();
  w.failOn.set("ig.upload", new DomainError({ code: "social_request_rejected", message: "Meta refused ig.upload: ProcessingFailedError: Request processing failed", details: { status: 400 } }));
  await w.run();
  assert.equal(w.job("s6", "instagram")!.status, "failed");
  assert.equal(w.job("s6", "instagram")!.errorCode, "social_request_rejected");
  assert.equal(w.job("s6", "facebook")!.status, "published");
});

test("runner: Instagram throwing something unexpected -> Facebook still published", async () => {
  const w = await world();
  w.failOn.set("ig.container 1784", new TypeError("boom"));
  await w.run();
  assert.equal(w.job("s6", "instagram")!.errorCode, "internal_error");
  assert.equal(w.job("s6", "facebook")!.status, "published");
});

test("runner: Instagram's quota unknown -> Instagram waits (no job), Facebook published", async () => {
  const w = await world({ igUsage: async () => null });
  await w.run();
  assert.equal(w.job("s6", "instagram"), undefined);
  assert.equal(w.job("s6", "facebook")!.status, "published");
});

test("runner: Instagram's own time missed by more than 12 h -> missed_window for Instagram only, Facebook published", async () => {
  // Instagram at 00:00 of the slot's day, Facebook at 13:00; the computer starts posting just after 13:00 (13 h late for Instagram).
  const e = slot("s6", T0, { crossPost: { instagram: { caption: "IG", at: "00:00" }, facebook: { description: "FB", at: "13:00" } } });
  const w = await world({ entries: [e] });
  w.at(Date.parse("2026-11-20T13:00:00Z") + 1); // 13 h after Instagram's time, just after Facebook's
  assert.ok(Date.parse("2026-11-20T13:00:00Z") + 1 - Date.parse("2026-11-20T00:00:00Z") > MAX_LATE_MS);
  await w.run();
  assert.equal(w.job("s6", "instagram")!.errorCode, "missed_window");
  assert.equal(w.job("s6", "facebook")!.status, "published");
});

test("runner: Instagram unlinked over several days -> every later slot's Facebook Reel is published too", async () => {
  const day = 24 * 60 * 60_000;
  const w = await world({ entries: [slot("s6", T0), slot("s7", T0 + day), slot("s8", T0 + 2 * day)] });
  w.setInspection({ ...HEALTHY, instagram: null });
  for (const t of [T0, T0 + day, T0 + 2 * day]) {
    w.at(t);
    await w.run();
  }
  for (const s of ["s6", "s7", "s8"]) {
    assert.equal(w.job(s, "facebook")!.status, "published", s);
    assert.equal(w.job(s, "instagram")!.errorCode, "instagram_unlinked", s);
  }
});

test("runner: a Facebook Reel already processing is read back to published although Instagram became unlinked", async () => {
  const w = await world();
  await w.runner.tick(); // both started; Facebook's finish sent
  assert.equal(w.job("s6", "facebook")!.status, "processing");
  w.setInspection({ ...HEALTHY, instagram: null });
  await w.runner.tick();
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "instagram")!.errorCode, "instagram_unlinked", "Instagram's FINISHED container is not published to an unlinked account");
  assert.ok(!w.calls.some((c) => c.startsWith("ig.publish")));
});

test("runner: token invalid -> both failed token_invalid, nothing sent", async () => {
  const w = await world();
  w.setInspection({ valid: false, scopes: [], expiresAt: null, page: null, instagram: null });
  await w.run();
  assert.equal(w.job("s6", "facebook")!.errorCode, "token_invalid");
  assert.equal(w.job("s6", "instagram")!.errorCode, "token_invalid");
  assert.ok(noPostingCall(w.calls));
});

test("runner: the token reaches another Page -> both failed page_mismatch, no post sent anywhere", async () => {
  const w = await world();
  w.setInspection({ ...HEALTHY, page: { pageId: "222", pageName: "Other" } });
  await w.run();
  assert.equal(w.job("s6", "facebook")!.errorCode, "page_mismatch");
  assert.equal(w.job("s6", "instagram")!.errorCode, "page_mismatch");
  assert.ok(noPostingCall(w.calls));
});

test("runner: Instagram row removed by a reconnect -> Facebook published, Instagram failed not_connected", async () => {
  const w = await world();
  w.setPages([{ ...PAGE_WITH_IG, instagram: null }]);
  w.setInspection({ ...HEALTHY, instagram: null });
  await w.connect();
  await w.run();
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "instagram")!.status, "failed");
  assert.equal(w.job("s6", "instagram")!.errorCode, "not_connected");
  assert.ok(noIgCall(w.calls));
});

test("runner (reverse): Facebook's upload refused -> Instagram still published", async () => {
  const w = await world();
  w.failOn.set("fb.upload", new DomainError({ code: "social_request_rejected", message: "Meta refused fb.upload", details: { status: 400 } }));
  await w.run();
  assert.equal(w.job("s6", "facebook")!.errorCode, "social_request_rejected");
  assert.equal(w.job("s6", "instagram")!.status, "published");
  assert.ok(w.calls.includes("ig.publish 1784"));
});

// ----- criterion 4: no coupling in the runner loop -----

test("runner: an Instagram upload that hangs never delays Facebook; the next pass skips only the busy Instagram lane", async () => {
  const w = await world();
  w.holds.set("ig.upload", { release: () => undefined });
  const first = w.runner.tick();
  for (let i = 0; i < 200 && !w.calls.includes("fb.finish 111"); i++) await new Promise((r) => setImmediate(r));
  assert.ok(w.calls.includes("fb.finish 111"), "Facebook's finish went out while Instagram's upload was still hanging");
  assert.equal(w.job("s6", "instagram")!.status, "uploading");
  const second = await w.runner.tick();
  assert.deepEqual(second.busy, ["instagram"]);
  assert.equal(w.job("s6", "facebook")!.status, "published");
  assert.equal(w.job("s6", "instagram")!.status, "uploading", "the hanging upload is not taken for an interrupted one");
  w.holds.get("ig.upload")!.release();
  await first;
  assert.equal(w.job("s6", "instagram")!.status, "processing");
});

test("runner: a store error on one network's job skips only that step", async () => {
  const w = await world();
  // The job store reads through the world's map: make every read of the Instagram job throw (a disk error).
  const igId = jobIdOf("UC1", "s6", "instagram");
  Object.defineProperty(w.jobs, "has", {
    value: (id: string) => {
      if (id === igId) throw new Error("disk I/O error");
      return Map.prototype.has.call(w.jobs, id);
    },
  });
  const report = await w.runner.tick();
  assert.ok(report.errors.includes(igId));
  assert.equal(w.job("s6", "facebook")!.status, "processing");
  assert.ok(w.calls.includes("fb.finish 111"));
});

// ----- criterion 8 (owner TG 4780): the owner's retry posts a failed job however late -----
// Expected by hand: a retry recorded on the job lets the runner start it again past the 12 h window (approval, identity and quota
// still checked); without that retry a late post stays missed; a job that sent its publishing call is never retried.

const DAY = 24 * 60 * 60_000;
const FB_ONLY = { facebook: { title: "T", description: "FB" } };

function failedFacebookJob(slotId: string, plannedAt: number, over: Partial<SocialJob> = {}): SocialJob {
  return { jobId: jobIdOf("UC1", slotId, "facebook"), channelId: "UC1", slotId, video: slotId.toUpperCase(), network: "facebook", manifestSha256: `m-${slotId}`, plannedAt, status: "failed", remoteId: null, uploadUrl: null, remotePostId: null, permalink: null, publishAttempted: false, errorCode: "social_account_mismatch", errorMessage: "The connected Meta accounts did not pass the check (instagram_unlinked).", createdAt: plannedAt, updatedAt: plannedAt, ...over };
}

test("retry: a failed Facebook job 3 days late, retried by the owner, is posted", async () => {
  const w = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY })] });
  w.jobs.set(jobIdOf("UC1", "s6", "facebook"), failedFacebookJob("s6", T0));
  w.at(T0 + 3 * DAY);
  assert.deepEqual(await w.core.retryJob({ jobId: jobIdOf("UC1", "s6", "facebook") }), { retried: true });
  assert.equal(w.job("s6", "facebook")!.ownerRetryAt, T0 + 3 * DAY, "the retry is recorded on the job, not by removing it");
  await w.run();
  const job = w.job("s6", "facebook")!;
  assert.equal(job.status, "published");
  assert.equal(job.remotePostId, "V1");
  assert.equal(job.errorCode, null);
  assert.equal(job.ownerRetryAt, null);
  assert.deepEqual(w.calls.filter((c) => c.startsWith("fb.") && c !== "fb.status"), ["fb.start 111", "fb.upload", "fb.finish 111"]);
});

test("retry: without the owner's retry a 3-day-late post is never sent (missed_window; a failed job stays as it is)", async () => {
  const fresh = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY })] });
  fresh.at(T0 + 3 * DAY);
  await fresh.run();
  assert.equal(fresh.job("s6", "facebook")!.errorCode, "missed_window");
  assert.deepEqual(fresh.calls, []);

  const failed = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY })] });
  failed.jobs.set(jobIdOf("UC1", "s6", "facebook"), failedFacebookJob("s6", T0));
  failed.at(T0 + 3 * DAY);
  await failed.run();
  assert.equal(failed.job("s6", "facebook")!.status, "failed");
  assert.equal(failed.job("s6", "facebook")!.errorCode, "social_account_mismatch");
  assert.deepEqual(failed.calls, []);
});

test("retry: a job whose publishing call was sent (or that has a post id) is refused, and never re-posted even if marked", async () => {
  const w = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY })] });
  const id = jobIdOf("UC1", "s6", "facebook");
  w.at(T0 + 3 * DAY);
  for (const over of [{ publishAttempted: true }, { remotePostId: "V9" }] as Partial<SocialJob>[]) {
    w.jobs.set(id, failedFacebookJob("s6", T0, over));
    await assert.rejects(w.core.retryJob({ jobId: id }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
    w.jobs.set(id, failedFacebookJob("s6", T0, { ...over, ownerRetryAt: T0 + 3 * DAY }));
    await w.run();
    assert.equal(w.job("s6", "facebook")!.status, "failed");
  }
  assert.deepEqual(w.calls, []);
});

test("retry: three late retries of one channel in one run are all posted, within Facebook's 30 per 24 h", async () => {
  const w = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY }), slot("s7", T0 + DAY, { crossPost: FB_ONLY }), slot("s8", T0 + 2 * DAY, { crossPost: FB_ONLY })] });
  for (const [s, at] of [["s6", T0], ["s7", T0 + DAY], ["s8", T0 + 2 * DAY]] as const) w.jobs.set(jobIdOf("UC1", s, "facebook"), failedFacebookJob(s, at));
  w.at(T0 + 3 * DAY + 60_000);
  for (const s of ["s6", "s7", "s8"]) await w.core.retryJob({ jobId: jobIdOf("UC1", s, "facebook") });
  await w.run();
  for (const s of ["s6", "s7", "s8"]) assert.equal(w.job(s, "facebook")!.status, "published", s);
  assert.equal(w.calls.filter((c) => c.startsWith("fb.finish")).length, 3);
  const q = await w.core.quota("UC1");
  assert.deepEqual(q.facebook, { used: 3, limit: 30 });
});

test("retry: refused again by Facebook's identity read -> failed with its own code, the retry answered (no endless re-try)", async () => {
  const w = await world({ entries: [slot("s6", T0, { crossPost: FB_ONLY })] });
  w.jobs.set(jobIdOf("UC1", "s6", "facebook"), failedFacebookJob("s6", T0));
  w.at(T0 + 3 * DAY);
  await w.core.retryJob({ jobId: jobIdOf("UC1", "s6", "facebook") });
  w.setInspection({ ...HEALTHY, page: { pageId: "222", pageName: "Other" } });
  await w.run();
  const job = w.job("s6", "facebook")!;
  assert.equal(job.status, "failed");
  assert.equal(job.errorCode, "page_mismatch");
  assert.equal(job.ownerRetryAt, null);
  assert.deepEqual(w.calls, []);
});
