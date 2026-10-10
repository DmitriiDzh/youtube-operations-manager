import assert from "node:assert/strict";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import type { StoredGeminiCredentials } from "@/lib/db";
import { createGeminiMediaServices, DomainError, type GeminiMediaDeps, type GeminiStore } from "@/lib/gemini-media";
import { createGeminiKeyTestPostHandler } from "./credentials/test/route";
import { createGeminiKeyDeleteHandler, createGeminiKeyPutHandler } from "./credentials/route";
import { createGeminiOverviewGetHandler } from "./route";
import { createGeminiSettingsPutHandler } from "./settings/route";
import type { GeminiRouteDeps } from "./shared";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.8, AC-GM-01 at the HTTP boundary): 401 without a Web session; no response of any Gemini route
// carries the key; a key Google refuses is answered with its code and never stored; the settings are validated.

const KEY = "AIzaSySECRETSECRETSECRET0042";

function deps(opts: { session?: boolean; googleRefuses?: boolean } = {}): GeminiRouteDeps {
  let creds: StoredGeminiCredentials | null = null;
  let settings: string | null = null;
  let keyText: string | null = null;
  const access: KeyFileAccess = {
    read: async () => keyText,
    write: async (c) => {
      keyText = JSON.stringify(c);
    },
    remove: async () => {
      keyText = null;
    },
    randomBytes: (n) => Buffer.alloc(n, 3),
  };
  const store: GeminiStore = {
    getCredentials: async () => creds,
    upsertCredentials: async (input) => {
      creds = { id: "default", ...input, updatedAt: new Date("2026-10-10T12:00:00Z") };
    },
    clearCredentials: async () => {
      creds = null;
    },
    getSettingsJson: async () => settings,
    setSettingsJson: async (json) => {
      settings = json;
    },
    insertJob: async () => true,
    getJob: async () => null,
    getJobByRequest: async () => null,
    listJobs: async () => [],
    updateJob: async () => false,
  };
  const core = createGeminiMediaServices({
    store,
    api: {
      checkKey: async () => {
        if (opts.googleRefuses) throw new DomainError({ code: "gemini_key_invalid", message: "Google refused the API key (HTTP 400)", details: { outcome: "answered", status: 400 } });
      },
    } as unknown as GeminiMediaDeps["api"],
    keyFile: createKeyFile(access, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
    isGatewayEnabled: async () => true,
    clock: { now: () => new Date("2026-10-10T12:00:00Z") },
  } as unknown as GeminiMediaDeps);
  return { getSession: async () => (opts.session === false ? null : { user: { id: "owner" } }), core };
}

const json = (method: string, body?: unknown) =>
  new Request("http://localhost/api/gemini-media", { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("every Gemini route answers 401 without a Web session", async () => {
  const d = deps({ session: false });
  for (const handler of [createGeminiOverviewGetHandler(d), createGeminiSettingsPutHandler(d), createGeminiKeyPutHandler(d), createGeminiKeyDeleteHandler(d), createGeminiKeyTestPostHandler(d)]) {
    assert.equal((await handler(json("POST", {}))).status, 401);
  }
});

test("AC-GM-01 over HTTP: after the key is saved, no response carries it -- only its last 4 characters", async () => {
  const d = deps();
  const put = await createGeminiKeyPutHandler(d)(json("PUT", { apiKey: KEY }));
  assert.equal(put.status, 200);
  const bodies = [await put.text(), await (await createGeminiOverviewGetHandler(d)(json("GET"))).text(), await (await createGeminiKeyTestPostHandler(d)(json("POST"))).text()];
  for (const body of bodies) {
    assert.ok(!body.includes(KEY) && !body.includes(KEY.slice(0, 12)), body);
  }
  const overview = JSON.parse(bodies[1]);
  assert.deepEqual([overview.key.configured, overview.key.keyHint, overview.settings.enabled], [true, "0042", false]);
  const removed = await (await createGeminiKeyDeleteHandler(d)(json("DELETE"))).json();
  assert.equal(removed.configured, false);
});

test("a key Google refuses is answered 422 gemini_key_invalid and is not stored", async () => {
  const d = deps({ googleRefuses: true });
  const response = await createGeminiKeyPutHandler(d)(json("PUT", { apiKey: KEY }));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "gemini_key_invalid");
  assert.equal((await (await createGeminiOverviewGetHandler(d)(json("GET"))).json()).key.configured, false);
});

test("settings: the switch and limits are saved; a bad value or unknown field is refused", async () => {
  const d = deps();
  const ok = await createGeminiSettingsPutHandler(d)(json("PUT", { enabled: true, maxUsdPerDay: 3 }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { enabled: true, maxUsdPerJob: 1, maxUsdPerDay: 3, maxUsdPerMonth: 50, maxActiveJobs: 10 });
  for (const bad of [{ maxUsdPerDay: 0 }, { maxUsdPerDay: -1 }, { maxActiveJobs: 1.5 }, { enabled: "yes" }, { apiKey: KEY }]) {
    const response = await createGeminiSettingsPutHandler(d)(json("PUT", bad));
    assert.notEqual(response.status, 200, JSON.stringify(bad));
    assert.equal((await response.json()).error, "validation_failed");
  }
  assert.equal((await createGeminiSettingsPutHandler(d)(new Request("http://localhost/x", { method: "PUT", body: "{not json" }))).status, 400);
});
