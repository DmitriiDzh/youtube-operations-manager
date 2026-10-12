import assert from "node:assert/strict";
import test from "node:test";
import { createLiveStreamsSettings, liveStreamsHost } from "@/lib/live-streams/settings";
import { createLiveStreamsSettingsGetHandler, createLiveStreamsSettingsPutHandler } from "./route";

// BL-176 (§3.12, ADR 0036 §1): a Web session is required; the switch is refused (409) away from the Mac's system service.

function deps(opts: { session?: boolean; serviceMode?: string } = {}) {
  let json: string | null = null;
  return {
    getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }),
    settings: createLiveStreamsSettings({ getJson: async () => json, setJson: async (j) => void (json = j), host: () => liveStreamsHost({ platform: "darwin", serviceMode: opts.serviceMode }) }),
  };
}
const put = (body: unknown) => new Request("http://localhost/api/live-streams/settings", { method: "PUT", body: JSON.stringify(body) });

test("401 without a session", async () => {
  assert.equal((await createLiveStreamsSettingsGetHandler(deps({ session: false }))(new Request("http://localhost/"))).status, 401);
});

test("switching the module on away from the system service is a 409; on the service it is saved", async () => {
  const refused = await createLiveStreamsSettingsPutHandler(deps())(put({ enabled: true }));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "live_streams_host_unsupported");
  const ok = await createLiveStreamsSettingsPutHandler(deps({ serviceMode: "1" }))(put({ enabled: true, bufferDepth: 3 }));
  assert.equal(ok.status, 200);
  assert.deepEqual([(await ok.json()).enabled], [true]);
});
