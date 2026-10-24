import assert from "node:assert/strict";
import test from "node:test";
import type { SpendFilter, SpendInputs } from "@/lib/spend-analytics";
import { createSpendAnalyticsHandlers } from "./handlers";
import { createPreviewHandler, imageFiles } from "./preview/handlers";

// SERVERS_ANALYTICS_PLAN.md AC-SA-06/08/09: owner only, filters from the query, read-only previews of this computer's images.

const inputs: SpendInputs = { runs: [], computers: [], facts: { sessions: new Map(), jobs: new Map(), gemini: new Map() } };
const owner = async () => ({ user: { id: "owner" } });

function handlers(getSession: () => Promise<{ user?: { id?: string | null } } | null> = owner) {
  const seen: Array<{ filter: SpendFilter; options?: unknown }> = [];
  let reads = 0;
  const h = createSpendAnalyticsHandlers({
    getSession,
    readInputs: async () => ((reads += 1), inputs),
    summary: (_i, filter) => (seen.push({ filter }), { ok: true }) as never,
    history: (_i, filter, options) => (seen.push({ filter, options }), { rows: [] }) as never,
    now: () => new Date("2026-10-24T12:00:00Z"),
    channelTitles: async () => [{ channelId: "UC_T", title: "Tropico Jazz" }],
  });
  return { h, seen, reads: () => reads };
}

test("AC-SA-08: without a signed-in session both reads answer 401 and read nothing", async () => {
  const { h, reads } = handlers(async () => null);
  assert.equal((await h.summary(new Request("http://x/api/servers/analytics"))).status, 401);
  assert.equal((await h.history(new Request("http://x/api/servers/analytics/history"))).status, 401);
  assert.equal(reads(), 0);
});

test("AC-SA-06: the filters come from the query (defaults: 30 days, everything, UTC)", async () => {
  const { h, seen } = handlers();
  await h.summary(new Request("http://x/api/servers/analytics"));
  await h.history(new Request("http://x/api/servers/analytics/history?days=all&channelId=UC_T&device=this&who=agent&tz=Europe%2FMoscow&kind=gemini&errors=1&cursor=30"));
  assert.deepEqual(seen[0].filter, { days: 30, channelId: null, device: "all", who: "all", tz: "UTC" });
  assert.deepEqual(seen[1], { filter: { days: null, channelId: "UC_T", device: "this", who: "agent", tz: "Europe/Moscow" }, options: { kind: "gemini", errorsOnly: true, cursor: "30", day: null } });
});

test("AC-SA-06: an unknown value, time zone or extra key is refused with 400", async () => {
  const { h } = handlers();
  for (const query of ["days=14", "tz=Mars%2FBase", "who=everyone", "foo=1", "cursor=-1"]) {
    assert.equal((await h.summary(new Request(`http://x/api/servers/analytics?${query}`))).status, 400, query);
  }
});

test("AC-SA-09: only image outputs can be previewed, by plain file name", () => {
  assert.deepEqual(
    imageFiles(JSON.stringify([{ kind: "images", filename: "a.png" }, { kind: "gifs", filename: "b.mp4" }, { kind: "images", filename: "../x.png" }, { kind: "image", path: "gemini/gm_1/image-1.jpg", mimeType: "image/jpeg" }])),
    ["a.png", "image-1.jpg"]
  );
  assert.deepEqual(imageFiles("not json"), []);
});

test("AC-SA-09: a preview resolves inside the job's own folder, and a job or file it cannot find is 404", async () => {
  const resolved: string[] = [];
  const GET = createPreviewHandler({
    getSession: owner,
    jobOutputs: async (source, jobId) => (jobId === "J1" ? { channelId: "UC_T", outputsJson: JSON.stringify([{ kind: "images", filename: "a.png" }]) } : null),
    workspaceOf: async () => "/ws",
    resolveJobFile: async (workspace, subdir, folder, file) => (resolved.push(`${workspace}|${subdir}|${folder}|${file}`), { path: "/ws/a.png" }),
    preview: async () => new Uint8Array([1, 2, 3]),
    readFile: async () => new Uint8Array(),
  });
  const ok = await GET(new Request("http://x/p?source=runpod&jobId=J1&index=0"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(resolved, ["/ws|media|J1|a.png"]);
  assert.equal((await GET(new Request("http://x/p?source=runpod&jobId=J1&index=1"))).status, 404);
  assert.equal((await GET(new Request("http://x/p?source=gemini&jobId=nope"))).status, 404);
  assert.equal((await GET(new Request("http://x/p?source=runpod&jobId=..%2Fetc"))).status, 400);
});

// Review (BL-219): the real resolver composition -- a bare file name must resolve inside the job's own From YTM folder.
test("AC-SA-09 (real folder): the preview's resolver finds the file in the job folder and refuses one outside it", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { previewDeps } = await import("./preview/deps");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ws-"));
  try {
    const job = path.join(workspace, "99 Data Exchange", "From YTM", "media", "J1");
    await mkdir(job, { recursive: true });
    await writeFile(path.join(job, "a.png"), "png");
    await writeFile(path.join(workspace, "99 Data Exchange", "From YTM", "media", "outside.png"), "png");
    const found = await previewDeps.resolveJobFile(workspace, "media", "J1", "a.png");
    assert.ok(found.path.endsWith(path.join("J1", "a.png")));
    await assert.rejects(previewDeps.resolveJobFile(workspace, "media", "J1", "../outside.png"));
    await assert.rejects(previewDeps.resolveJobFile(workspace, "media", "J1", "missing.png"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
