import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteAccessServices } from "@/lib/remote-access";
import { createRemoteAccessHandlers } from "./shared";

// BL-251 AC-RA-4: the settings change only on the Mac itself -- refused here too, not only in src/proxy.ts.
function handlers(session = true) {
  let file: string | null = null;
  const core = createRemoteAccessServices({ store: { read: async () => file, write: async (j) => void (file = j) }, clock: { now: () => 1 } });
  return createRemoteAccessHandlers({ getSession: async () => (session ? { user: { id: "u" } } : null), core: () => core });
}
const put = (headers: Record<string, string>, body: unknown) =>
  new Request("http://127.0.0.1:3000/api/remote-access", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("PUT from the Mac sets the password and the switch; the answer never carries the hash", async () => {
  const h = handlers();
  const r = await h.PUT(put({ host: "127.0.0.1:3000" }, { password: "correct horse", enabled: true }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual([body.enabled, body.passwordSet], [true, true]);
  assert.equal(JSON.stringify(body).includes("Hash"), false);
});

test("PUT through tailscale serve is refused (remote_access_mac_only); no session -> 401", async () => {
  const h = handlers();
  const r = await h.PUT(put({ host: "127.0.0.1:3000", "x-forwarded-for": "100.64.0.7" }, { enabled: true }));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "remote_access_mac_only");
  const anon = await handlers(false).PUT(put({ host: "127.0.0.1:3000" }, { enabled: false }));
  assert.equal(anon.status, 401);
});
