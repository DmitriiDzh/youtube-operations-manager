import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryCandidatesGetHandler, type DiscoveryCandidatesDeps } from "./route";

// BL-140 R4 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.5/§6, AC-R4-1). Fixture in the service's order
// (newest lastSeenAt first); expected pages written by hand.
const candidates = [
  { channelId: "UC-n1", status: "new" },
  { channelId: "UC-p1", status: "promoted" },
  { channelId: "UC-n2", status: "new" },
  { channelId: "UC-w1", status: "watching" },
  { channelId: "UC-n3", status: "new" },
  { channelId: "UC-i1", status: "ignored" },
];
const core = { listDiscoveryCandidates: async () => ({ candidates }) } as unknown as DiscoveryCandidatesDeps["core"];
const session = async () => ({ user: { id: "u" } });
const get = (qs: string) => createDiscoveryCandidatesGetHandler({ getSession: session, core })(new Request(`http://x/api?${qs}`));
const ids = (body: { candidates: { channelId: string }[] }) => body.candidates.map((c) => c.channelId);

test("AC-R4-1: status=new lists only new candidates, in order; a promoted one is never in New", async () => {
  const body = await (await get("page=1&status=new")).json();
  assert.deepEqual(ids(body), ["UC-n1", "UC-n2", "UC-n3"]);
  assert.equal(body.total, 3);
  assert.deepEqual(body.counts, { new: 3, watching: 1, ignored: 1, archived: 0, promoted: 1 });
  assert.deepEqual(ids(await (await get("page=1&status=promoted")).json()), ["UC-p1"]);
});

test("AC-R4-1: paging slices the filtered list; a page past the end is empty with the right total", async () => {
  const page2 = await (await get("page=2&limit=2&status=new")).json();
  assert.deepEqual(ids(page2), ["UC-n3"]);
  assert.equal(page2.total, 3);
  assert.equal(page2.page, 2);
  const past = await (await get("page=9&limit=2&status=new")).json();
  assert.deepEqual(past.candidates, []);
  assert.equal(past.total, 3);
});

test("an unknown status means all statuses; limit is capped at 100; no page parameter keeps the old shape", async () => {
  const all = await (await get("page=1&status=bogus&limit=500")).json();
  assert.equal(all.total, 6);
  assert.equal(all.limit, 100);
  assert.deepEqual(await (await get("")).json(), { candidates });
});

test("the candidates route needs a session", async () => {
  const res = await createDiscoveryCandidatesGetHandler({ getSession: async () => null, core })(new Request("http://x/api?page=1"));
  assert.equal(res.status, 401);
});
