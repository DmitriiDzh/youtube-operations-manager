import assert from "node:assert/strict";
import test from "node:test";
import type { MediaGenerationCore } from "@/lib/media-generation";
import { createKeyFile, type KeyFileAccess } from "@/lib/media-generation/key-file";
import { createMediaGenerationServices, type MediaGenerationStore, type StoredCredentialsRow } from "@/lib/media-generation/services";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { createCredentialsExportPostHandler } from "./export/route";
import { createCredentialsImportPostHandler } from "./import/route";
import { createCredentialsDeleteHandler, createCredentialsGetHandler, createCredentialsPutHandler } from "./route";
import { createOverviewGetHandler } from "../overview/route";

// AC-P14-02 / AC-P14-21 at the HTTP boundary: 401 without a session; after a save, no response
// body of any media-generation route carries the key or the S3 secret.

const RUNPOD_KEY = "rpa_SECRETSECRETSECRETSECRETSECRET";
const S3_SECRET = "rps_verysecretvalue";

function core(opts: { runpodAccepts?: boolean } = {}): MediaGenerationCore {
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
    remove: async () => {
      keyContent = null;
    },
  };
  return createMediaGenerationServices({
    store,
    keyFile: createKeyFile(access),
    gateway: {
      createRunpodClient: () =>
        ({
          async verifyKey() {
            if (opts.runpodAccepts === false) throw new Error("RunPod rejected the API key (HTTP 401).");
            return { ok: true as const };
          },
        }) as unknown as RunpodApiClient,
      createS3Client: () => ({}) as RunpodS3Client,
    },
    clock: { now: () => new Date("2026-10-05T00:00:00Z") },
    passwordScrypt: { N: 2 ** 10, r: 8, p: 1 }, // cheap in tests; production uses 2^17
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

// BL-137 (owner, Telegram 2026-10-06, variant A): credentials move between devices as a password-encrypted file. Each core here
// is a separate device (own store, own key file). Requirement: the file and every response carry no key in clear; the right
// password on another device yields the same credentials; a wrong password, or a key RunPod rejects, changes nothing.
const PASSWORD = "long enough passphrase";

async function exportFrom(device: MediaGenerationCore, password = PASSWORD) {
  return createCredentialsExportPostHandler({ ...authed, core: device })(jsonRequest("POST", { password }));
}

test("export → import on another device: same credentials there, and no response or file carries a secret", async () => {
  const a = core();
  await createCredentialsPutHandler({ ...authed, core: a })(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_1", s3SecretAccessKey: S3_SECRET }));
  const exported = await exportFrom(a);
  assert.equal(exported.status, 200);
  const exportedText = await exported.text();
  assert.ok(!exportedText.includes(RUNPOD_KEY) && !exportedText.includes(S3_SECRET) && !exportedText.includes(PASSWORD));
  const { file } = JSON.parse(exportedText);
  assert.equal(file.format, "ytm-runpod-credentials");
  assert.deepEqual(file.hints, { runpodKeyPrefix: "rpa_SECR…", s3AccessKeyId: "user_1" });

  const b = core();
  const imported = await createCredentialsImportPostHandler({ ...authed, core: b })(jsonRequest("POST", { file, password: PASSWORD }));
  assert.equal(imported.status, 200);
  const importedText = await imported.text();
  assert.ok(!importedText.includes(RUNPOD_KEY) && !importedText.includes(S3_SECRET));
  const status = await b.getCredentialsStatus();
  assert.equal(status.configured, true);
  assert.ok(status.configured && status.runpodKeyPrefix === "rpa_SECR…" && status.s3AccessKeyId === "user_1");
  // Device B can export again, and that file opens with the same password: the secrets themselves arrived intact.
  const again = JSON.parse(await (await exportFrom(b)).text()).file;
  const c = core();
  assert.equal((await createCredentialsImportPostHandler({ ...authed, core: c })(jsonRequest("POST", { file: again, password: PASSWORD }))).status, 200);
});

test("import with a wrong password, a tampered file, or a key RunPod rejects changes nothing", async () => {
  const a = core();
  await createCredentialsPutHandler({ ...authed, core: a })(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY }));
  const { file } = JSON.parse(await (await exportFrom(a)).text());
  const b = core();
  const wrong = await createCredentialsImportPostHandler({ ...authed, core: b })(jsonRequest("POST", { file, password: "not the password" }));
  assert.equal(wrong.status, 400);
  assert.match(JSON.parse(await wrong.text()).message, /Wrong password/);
  const tampered = { ...file, encrypted: { ...file.encrypted, authTag: Buffer.alloc(16, 7).toString("base64") } };
  assert.equal((await createCredentialsImportPostHandler({ ...authed, core: b })(jsonRequest("POST", { file: tampered, password: PASSWORD }))).status, 400);
  const notAFile = await createCredentialsImportPostHandler({ ...authed, core: b })(jsonRequest("POST", { file: { format: "something-else" }, password: PASSWORD }));
  assert.equal(JSON.parse(await notAFile.text()).error, "validation_failed");
  assert.deepEqual(await b.getCredentialsStatus(), { configured: false, reason: "no_credentials" });

  const rejecting = core({ runpodAccepts: false });
  const rejected = await createCredentialsImportPostHandler({ ...authed, core: rejecting })(jsonRequest("POST", { file, password: PASSWORD }));
  assert.equal(JSON.parse(await rejected.text()).error, "media_credentials_invalid");
  assert.deepEqual(await rejecting.getCredentialsStatus(), { configured: false, reason: "no_credentials" });
});

test("export needs a session, stored credentials, and a password of at least 12 characters", async () => {
  const a = core();
  assert.equal((await createCredentialsExportPostHandler({ ...anonymous, core: a })(jsonRequest("POST", { password: PASSWORD }))).status, 401);
  assert.equal(JSON.parse(await (await exportFrom(a)).text()).error, "media_generation_not_configured");
  await createCredentialsPutHandler({ ...authed, core: a })(jsonRequest("PUT", { runpodApiKey: RUNPOD_KEY }));
  const short = await exportFrom(a, "elevenchars");
  assert.equal(JSON.parse(await short.text()).error, "validation_failed");
  assert.equal((await exportFrom(a, "twelve chars")).status, 200);
  assert.equal((await createCredentialsImportPostHandler({ ...anonymous, core: a })(jsonRequest("POST", { file: {}, password: "x" }))).status, 401);
});
