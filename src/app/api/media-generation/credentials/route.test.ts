import assert from "node:assert/strict";
import test from "node:test";
import type { MediaGenerationCore } from "@/lib/media-generation";
import { createKeyFile, type KeyFileAccess } from "@/lib/media-generation/key-file";
import { createMediaGenerationServices, type MediaGenerationStore, type StoredCredentialsRow } from "@/lib/media-generation/services";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { createCredentialsDeleteHandler, createCredentialsGetHandler, createCredentialsPutHandler } from "./route";
import { createOverviewGetHandler } from "../overview/route";

// AC-P14-02 / AC-P14-21 at the HTTP boundary: 401 without a session; after a save, no response
// body of any media-generation route carries the key or the S3 secret.

const RUNPOD_KEY = "rpa_SECRETSECRETSECRETSECRETSECRET";
const S3_SECRET = "rps_verysecretvalue";

function core(): MediaGenerationCore {
  let row: StoredCredentialsRow | null = null;
  let keyContent: string | null = null;
  let settings: string | null = null;
  const store: MediaGenerationStore = {
    getCredentials: async () => row,
    upsertCredentials: async (input) => {
      row = { ...input, verifiedAt: null, updatedAt: new Date("2026-10-05T00:00:00Z") };
    },
    setCredentialsVerifiedAt: async () => {},
    clearCredentials: async () => {
      row = null;
    },
    getSettingsJson: async () => settings,
    setSettingsJson: async (json) => {
      settings = json;
    },
    getGatewayEnabled: async () => true,
    setGatewayEnabled: async () => {},
  };
  const access: KeyFileAccess = {
    read: async () => keyContent,
    write: async (c) => {
      keyContent = JSON.stringify(c);
    },
    randomBytes: (n) => Buffer.alloc(n, 1),
  };
  return createMediaGenerationServices({
    store,
    keyFile: createKeyFile(access),
    gateway: {
      createRunpodClient: () => ({}) as RunpodApiClient,
      createS3Client: () => ({}) as RunpodS3Client,
    },
    clock: { now: () => new Date("2026-10-05T00:00:00Z") },
  }) as unknown as MediaGenerationCore;
}

const authed = { getSession: async () => ({ user: { id: "u1" } }), isConnectedChannel: async () => true };
const anonymous = { getSession: async () => null, isConnectedChannel: async () => true };

function jsonRequest(method: string, body: unknown): Request {
  return new Request("http://localhost/api/media-generation/credentials", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("unauthenticated GET/PUT/DELETE -> 401, nothing stored", async () => {
  const c = core();
  const deps = { ...anonymous, core: c };
  assert.equal((await createCredentialsGetHandler(deps)(new Request("http://localhost/x"))).status, 401);
  assert.equal((await createCredentialsPutHandler(deps)(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY }))).status, 401);
  assert.equal((await createCredentialsDeleteHandler(deps)(new Request("http://localhost/x", { method: "DELETE" }))).status, 401);
  assert.deepEqual(await c.getCredentialsStatus(), { configured: false, reason: "no_credentials" });
});

test("PUT stores the keys and returns the public status only; GET and the overview never echo a secret", async () => {
  const c = core();
  const deps = { ...authed, core: c };
  const put = await createCredentialsPutHandler(deps)(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_1", s3SecretAccessKey: S3_SECRET }));
  assert.equal(put.status, 200);
  const putText = await put.text();
  assert.ok(!putText.includes(RUNPOD_KEY) && !putText.includes(S3_SECRET));
  assert.equal(JSON.parse(putText).runpodKeyPrefix, "rpa_SECR…");

  const get = await createCredentialsGetHandler(deps)(new Request("http://localhost/x"));
  const getText = await get.text();
  assert.ok(!getText.includes(RUNPOD_KEY) && !getText.includes(S3_SECRET));
  assert.equal(JSON.parse(getText).configured, true);

  const overview = await createOverviewGetHandler(deps)(new Request("http://localhost/x"));
  const overviewText = await overview.text();
  assert.ok(!overviewText.includes(RUNPOD_KEY) && !overviewText.includes(S3_SECRET));
});

test("PUT with an invalid body -> 400/422 validation_failed and nothing stored; malformed JSON -> 400", async () => {
  const c = core();
  const deps = { ...authed, core: c };
  const bad = await createCredentialsPutHandler(deps)(jsonRequest("PUT", { runpodApiKey: "short" }));
  assert.equal(JSON.parse(await bad.text()).error, "validation_failed");
  assert.ok(bad.status === 400 || bad.status === 422);
  const malformed = await createCredentialsPutHandler(deps)(new Request("http://localhost/x", { method: "PUT", body: "{" }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await c.getCredentialsStatus(), { configured: false, reason: "no_credentials" });
});

test("DELETE clears the credentials", async () => {
  const c = core();
  const deps = { ...authed, core: c };
  await createCredentialsPutHandler(deps)(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY }));
  const res = await createCredentialsDeleteHandler(deps)(new Request("http://localhost/x", { method: "DELETE" }));
  assert.deepEqual(JSON.parse(await res.text()), { configured: false, reason: "no_credentials" });
});

// Review round 4 (AGENTS.md §F): the operator routes that take a body channelId verify it is a connected channel.
test("POST /sessions and POST /jobs refuse a channelId that is not a connected channel, before the core is reached", async () => {
  const { createSessionsPostHandler } = await import("../sessions/route");
  const { createJobsPostHandler } = await import("../jobs/route");
  const calls: string[] = [];
  const c = {
    requestSession: async () => {
      calls.push("requestSession");
      return {};
    },
    createJob: async () => {
      calls.push("createJob");
      return {};
    },
  } as unknown as MediaGenerationCore;
  const deps = { getSession: async () => ({ user: { id: "u1" } }), core: c, isConnectedChannel: async (id: string) => id === "UC_connected" };
  const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const s = await createSessionsPostHandler(deps)(post("http://localhost/api/media-generation/sessions", { channelId: "anything" }));
  assert.equal(s.status, 404);
  assert.equal(JSON.parse(await s.text()).error, "channel_not_connected");
  const j = await createJobsPostHandler(deps)(post("http://localhost/api/media-generation/jobs", { channelId: "anything", sessionId: "s", templateId: "t" }));
  assert.equal(j.status, 404);
  assert.deepEqual(calls, []);
  const ok = await createSessionsPostHandler(deps)(post("http://localhost/api/media-generation/sessions", { channelId: "UC_connected" }));
  assert.equal(ok.status, 201);
  assert.deepEqual(calls, ["requestSession"]);
});
