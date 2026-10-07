import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { DomainError } from "@/lib/shared-domain";
import { createExchangeFs, resolveFromYtmJobFile, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createAuditionGetHandler, parseRange } from "./serve";

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

function handler(ws: string, targets: Record<string, { kind: "sent"; relativePath: string } | { kind: "job"; jobId: string; localPath: string }>, opts: { session?: boolean } = {}) {
  const unavailable = (reason: string) => new Error(reason);
  return createAuditionGetHandler({
    getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }),
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
  h(new Request(`http://127.0.0.1:3000/api/generation-plans/${planId}/audition?${query}`, { headers }), { params: Promise.resolve({ planId }) });

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
  for (const bad of ["bytes=1000-", "bytes=5-2", "bytes=-0", "bytes=-", "items=0-1", "bytes=0-1,5-6"]) assert.equal(parseRange(bad, 1000), "invalid", bad);
});
