import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("GET /api/presence answers 200 {ok:true}, uncached, with no session or database involved", async () => {
  const res = GET();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("cache-control"), "no-store");
});
