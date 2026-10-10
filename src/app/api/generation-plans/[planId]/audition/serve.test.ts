import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { DomainError } from "@/lib/shared-domain";
import { createExchangeFs, resolveFromYtmJobFile, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createAuditionGetHandler, createRecheckAuditionGetHandler, createReferenceGetHandler, parseRange } from "./serve";

// AC-GP-14 (GENERATION_PLANS_PLAN.md §4): the audition route serves only the file of the plan's own attempt, found by the
// plans core and proven inside the channel workspace; Range works; a missing file is a 404 with a message.

async function workspaceWithFiles() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-audition-")));
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-audition-out-")));
  const ws = path.join(root, "ws");
  const sent = path.join(ws, "99 Data Exchange", "Sent to YTM", "R-0001", "C1");
  const jobDir = path.join(ws, "99 Data Exchange", "From YTM", "media", "job-1");
  await mkdir(sent, { recursive: true });
  await mkdir(jobDir, { recursive: true });
  await writeFile(path.join(sent, "final-1.mp3"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  await writeFile(path.join(sent, "notes.txt"), "text");
  await writeFile(path.join(jobDir, "a.mp3"), "0123456789");
  await writeFile(path.join(outside, "secret.mp3"), "secret");
  await symlink(path.join(outside, "secret.mp3"), path.join(sent, "escape.mp3"));
  return { root, outside, ws, jobDir, cleanup: async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]) };
}

function handler(ws: string, targets: Record<string, { kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string }>, opts: { session?: boolean; activePlans?: string[] } = {}) {
  const unavailable = (reason: string) => new Error(reason);
  return createAuditionGetHandler({
    getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }),
    // BL-157 (AC-SM-03): only a plan of the session's active channel (by default every plan the test names is).
    async assertVisible(_userId, planId) {
      if (opts.activePlans && !opts.activePlans.includes(planId)) throw new DomainError({ code: "plan_not_found", message: `Plan ${planId} not found` });
    },
    async resolveAudition({ planId, itemKey, attemptRef }) {
      const target = targets[`${planId}|${itemKey}|${attemptRef}`];
      if (!target) throw new DomainError({ code: "plan_mismatch", message: "nothing to play" });
      return { channelId: "UC1", ...target };
    },
    workspaceOf: async () => ws,
    resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
    resolveJobFile: (workspace, jobId, filePath) => resolveFromYtmJobFile({ workspace, subdir: "media", jobId, filePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
  });
}

const get = (h: ReturnType<typeof handler>, query: string, headers: Record<string, string> = {}, planId = "P1") =>
  h(new Request(`http://127.0.0.1:3000/api/generation-plans/${planId}/audition?${query}`, { headers: { host: "127.0.0.1:3000", ...headers } }), { params: Promise.resolve({ planId }) });

test("AC-GP-14: the plan attempt's file is served with its type; Range bytes=0-99 is a 206 with exactly 100 bytes", async () => {
  const w = await workspaceWithFiles();
  try {
    const h = handler(w.ws, { "P1|C1/F1|job:job-1": { kind: "sent", relativePath: "R-0001/C1/final-1.mp3" }, "P1|C1/F2|job:job-1": { kind: "job", jobId: "job-1", localPath: path.join(w.jobDir, "a.mp3") } });
    const whole = await get(h, "itemKey=C1/F1&attemptRef=job:job-1");
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/mpeg");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);
    const part = await get(h, "itemKey=C1/F1&attemptRef=job:job-1", { range: "bytes=0-99" });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 0-99/1000");
    const bytes = new Uint8Array(await part.arrayBuffer());
    assert.equal(bytes.length, 100);
    assert.equal(bytes[99], 99);
    const job = await get(h, "itemKey=C1/F2&attemptRef=job:job-1");
    assert.equal(await job.text(), "0123456789");
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:job-1", { range: "bytes=5000-" })).status, 416);
  } finally {
    await w.cleanup();
  }
});

test("AC-GP-14: another plan's attempt, a path in the query, a symlink out, a disallowed type, a missing file and no session are refused", async () => {
  const w = await workspaceWithFiles();
  try {
    const h = handler(w.ws, {
      "P1|C1/F1|job:link": { kind: "sent", relativePath: "R-0001/C1/escape.mp3" },
      "P1|C1/F1|job:txt": { kind: "sent", relativePath: "R-0001/C1/notes.txt" },
      "P1|C1/F1|job:gone": { kind: "sent", relativePath: "R-0001/C1/missing.mp3" },
      "P1|C1/F1|job:ok": { kind: "sent", relativePath: "R-0001/C1/final-1.mp3" },
    });
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:ok", {}, "P2")).status, 422, "another plan has no such attempt (plan_mismatch)");
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:ok&path=/etc/passwd")).status, 400, "a path in the query");
    const link = await get(h, "itemKey=C1/F1&attemptRef=job:link");
    assert.equal(link.status, 404);
    assert.match((await link.json()).message, /not available on this device/);
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:txt")).status, 415);
    const missing = await get(h, "itemKey=C1/F1&attemptRef=job:gone");
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).message, /not available on this device/);
    assert.equal((await get(handler(w.ws, {}, { session: false }), "itemKey=C1/F1&attemptRef=job:ok")).status, 401);
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:ok", { host: "203.0.113.5:3000" })).status, 403, "not loopback");
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:ok", { origin: "https://evil.example" })).status, 403, "a foreign page's origin");
  } finally {
    await w.cleanup();
  }
});

test("parseRange follows RFC 9110 single ranges", () => {
  assert.equal(parseRange(null, 10), null);
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=990-", 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange("bytes=-10", 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 }, "the end is clamped");
  for (const bad of ["bytes=1000-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1"]) assert.equal(parseRange(bad, 1000), "invalid", bad);
  assert.equal(parseRange("bytes=0-1,5-6", 1000), null, "multi-range: the whole file (RFC 9110 lets a server ignore it)");
});

test("AC-GP3-07: a reference is served by its id only (the plan names the file), with the same checks and Range", async () => {
  const w = await workspaceWithFiles();
  try {
    const unavailable = (reason: string) => new Error(reason);
    const h = createReferenceGetHandler({
      getSession: async () => ({ user: { id: "u1" } }),
      assertVisible: async () => undefined,
      async resolveReference({ id }) {
        if (id !== "koto") throw new DomainError({ code: "plan_mismatch", message: "no such reference" });
        return { channelId: "UC1", kind: "sent", relativePath: "R-0001/C1/final-1.mp3" };
      },
      workspaceOf: async () => w.ws,
      resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
      resolveJobFile: async () => {
        throw new Error("never");
      },
    });
    const call = (query: string, headers: Record<string, string> = {}) => h(new Request(`http://127.0.0.1:3000/api/generation-plans/P1/reference?${query}`, { headers: { host: "127.0.0.1:3000", ...headers } }), { params: Promise.resolve({ planId: "P1" }) });
    const ok = await call("id=koto", { range: "bytes=0-9" });
    assert.equal(ok.status, 206);
    assert.equal((await ok.arrayBuffer()).byteLength, 10);
    assert.equal((await call("id=other")).status, 422);
    assert.equal((await call("id=koto&file=/etc/passwd")).status, 400);
    assert.equal((await call("")).status, 400);
  } finally {
    await w.cleanup();
  }
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-03, ADR 0004 (b)): a plan of a channel that is not the session's active one is not
// served -- the same 404 as an unknown plan, before any file is looked at.
test("AC-SM-03: a plan that is not the active channel's is not found (404); the active channel's plays", async () => {
  const w = await workspaceWithFiles();
  try {
    const h = handler(w.ws, { "P1|C1/F1|job:job-1": { kind: "sent", relativePath: "R-0001/C1/final-1.mp3" }, "P2|C1/F1|job:job-1": { kind: "sent", relativePath: "R-0001/C1/final-1.mp3" } }, { activePlans: ["P1"] });
    assert.equal((await get(h, "itemKey=C1/F1&attemptRef=job:job-1", {}, "P1")).status, 200);
    const other = await get(h, "itemKey=C1/F1&attemptRef=job:job-1", {}, "P2");
    assert.equal(other.status, 404);
    assert.equal(((await other.json()) as { error: string }).error, "plan_not_found");
  } finally {
    await w.cleanup();
  }
});

test("BL-173 (§2.4): a re-check's file is served by its re-check id only, with the same checks and Range", async () => {
  const w = await workspaceWithFiles();
  try {
    const unavailable = (reason: string) => new Error(reason);
    const asked: string[] = [];
    const h = createRecheckAuditionGetHandler({
      getSession: async () => ({ user: { id: "u1" } }),
      assertVisible: async () => undefined,
      async resolveRecheck({ planId, recheckId }) {
        asked.push(`${planId}|${recheckId}`);
        if (recheckId === "r1") return { channelId: "UC1", kind: "sent", relativePath: "R-0001/C1/final-1.mp3" };
        if (recheckId === "escape") return { channelId: "UC1", kind: "sent", relativePath: "R-0001/C1/escape.mp3" };
        throw new DomainError({ code: "plan_mismatch", message: "no such re-check" });
      },
      workspaceOf: async () => w.ws,
      resolveSentFile: (workspace, relativePath) => resolveSentToYtmFile({ workspace, relativePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
      resolveJobFile: async () => {
        throw new Error("not used");
      },
    });
    const at = (query: string, headers: Record<string, string> = {}) => h(new Request(`http://127.0.0.1:3000/api/generation-plans/P1/recheck-audition?${query}`, { headers: { host: "127.0.0.1:3000", ...headers } }), { params: Promise.resolve({ planId: "P1" }) });
    const ok = await at("recheckId=r1", { range: "bytes=0-9" });
    assert.equal(ok.status, 206);
    assert.equal(ok.headers.get("content-type"), "audio/mpeg");
    assert.equal((await ok.arrayBuffer()).byteLength, 10);
    assert.equal((await at("recheckId=r1&file=../../x.mp3")).status, 400, "nothing but the re-check id");
    assert.equal((await at("")).status, 400);
    assert.equal((await at("recheckId=unknown")).status, 422);
    assert.equal((await at("recheckId=escape")).status, 404, "a symlink out of Sent to YTM is not served");
    assert.deepEqual(asked, ["P1|r1", "P1|unknown", "P1|escape"]);
  } finally {
    await w.cleanup();
  }
});
