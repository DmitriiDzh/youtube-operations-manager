import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPublishingSettingsService } from "@/lib/publishing/settings-service";
import { createPublishingSettingsHandlers, type PublishingSettingsRouteDeps } from "./route";

// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; owner msg 2715): a Web session is required; only the active channel
// (ADR 0004); a save carries only known, valid fields and nothing is saved when one is not; a field never saved shows its default.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const put = (body: unknown) => new Request("http://x/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function handlers(overrides: Partial<PublishingSettingsRouteDeps> = {}) {
  const stored: Record<string, unknown> = {};
  const saves: unknown[] = [];
  const service = createPublishingSettingsService({
    store: {
      read: async () => ({ values: { ...stored }, conflicts: [] }),
      save: async (_channelId, patch) => {
        saves.push(patch);
        Object.assign(stored, patch);
        return { changed: Object.keys(patch) };
      },
    },
  });
  const deps: PublishingSettingsRouteDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
    },
    service: () => service,
    ...overrides,
  };
  return { ...createPublishingSettingsHandlers(deps), saves };
}

test("401 without a session; another channel than the active one is refused; nothing is saved", async () => {
  const anonymous = handlers({ getSession: async () => null });
  assert.equal((await anonymous.GET(new Request("http://x/"), ctx("UC_active"))).status, 401);
  assert.equal((await anonymous.PUT(put({ publishTimeUtc: "12:00" }), ctx("UC_active"))).status, 401);
  const h = handlers();
  assert.notEqual((await h.GET(new Request("http://x/"), ctx("UC_other"))).status, 200);
  assert.notEqual((await h.PUT(put({ publishTimeUtc: "12:00" }), ctx("UC_other"))).status, 200);
  assert.deepEqual([...anonymous.saves, ...h.saves], []);
});

test("nothing saved: the defaults, 12:00 UTC and AI use on; a save keeps only what was sent", async () => {
  const h = handlers();
  const first = await (await h.GET(new Request("http://x/"), ctx("UC_active"))).json();
  assert.equal(first.settings.publishTimeUtc, "12:00");
  assert.equal(first.settings.containsSyntheticMedia, true);
  assert.deepEqual(first.saved, []);
  const res = await h.PUT(put({ playlistId: "PL_jazz", notifySubscribers: false }), ctx("UC_active"));
  assert.equal(res.status, 200);
  const after = await res.json();
  assert.equal(after.settings.playlistId, "PL_jazz");
  assert.equal(after.settings.notifySubscribers, false);
  assert.equal(after.settings.publishTimeUtc, "12:00");
  assert.deepEqual(after.saved, ["playlistId", "notifySubscribers"]);
  assert.deepEqual(h.saves, [{ playlistId: "PL_jazz", notifySubscribers: false }]);
});

test("an invalid or unknown field is a 400 and nothing is saved", async () => {
  const h = handlers();
  for (const body of [{ publishTimeUtc: "25:00" }, { playlistId: "PL_ok", madeForKids: "false" }, { title: "x" }, {}]) {
    const res = await h.PUT(put(body), ctx("UC_active"));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(h.saves, []);
});
