import assert from "node:assert/strict";
import test from "node:test";
import { cloudCredentialSections, createCloudCredentialsTransfer } from "@/lib/cloud-credentials-transfer";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import type { StoredGeminiCredentials } from "@/lib/db";
import { createGeminiMediaServices, type GeminiMediaDeps, type GeminiStore } from "@/lib/gemini-media";
import { DomainError } from "@/lib/media-generation";
import { createKeyFile as createRunpodKeyFile, type KeyFileAccess as RunpodKeyFileAccess } from "@/lib/media-generation/key-file";
import { createMediaGenerationServices, type MediaGenerationStore, type StoredCredentialsRow } from "@/lib/media-generation/services";
import type { RunpodApiClient, RunpodS3Client } from "@/lib/media-gateway";
import { encryptWithPassword } from "@/lib/shared-crypto";
import { createCloudCredentialsExportPostHandler } from "./export/route";
import { createCloudCredentialsImportPostHandler } from "./import/route";

// BL-193 (owner msgs 2864/2867, variant 1; ADR 0039 §6, extending ADR 0027 / BL-137): ONE password-encrypted file carries every
// cloud key -- RunPod with its S3 pair, and the Gemini key -- to another computer. Each "computer" below is its own pair of real
// module services (own stores, own key files) with fake providers. Requirements: no file or response carries a key or the password;
// the right password on another computer yields the same keys there; a file without a section never touches that section's stored
// key; BL-137's RunPod-only file still imports; a wrong password, a damaged file, or any key its provider refuses changes nothing.

const RUNPOD_KEY = "rpa_SECRETSECRETSECRETSECRETSECRET";
const S3_SECRET = "rps_verysecretvalue";
const GEMINI_KEY = "AIzaSyGEMINISECRETSECRETSECRET42";
const OTHER_GEMINI_KEY = "AIzaSyALREADYHEREALREADYHERE0007";
const PASSWORD = "long enough passphrase";
const FAST = { N: 2 ** 10, r: 8, p: 1 }; // cheap in tests; production uses 2^17

function computer(opts: { runpodAccepts?: boolean; runpodError?: DomainError; googleRefuses?: boolean } = {}) {
  let row: StoredCredentialsRow | null = null;
  let runpodKeyText: string | null = null;
  const store: MediaGenerationStore = {
    getCredentials: async () => row,
    upsertCredentials: async (input) => {
      row = { ...input, verifiedAt: null, updatedAt: new Date("2026-10-16T00:00:00Z") };
    },
    setCredentialsVerifiedAt: async () => {},
    clearCredentials: async () => {
      row = null;
    },
    getSettingsJson: async () => null,
    setSettingsJson: async () => {},
    getGatewayEnabled: async () => true,
    setGatewayEnabled: async () => {},
  };
  const runpodAccess: RunpodKeyFileAccess = {
    read: async () => runpodKeyText,
    write: async (c) => {
      runpodKeyText = JSON.stringify(c);
    },
    randomBytes: (n) => Buffer.alloc(n, 1),
    remove: async () => {
      runpodKeyText = null;
    },
  };
  const media = createMediaGenerationServices({
    store,
    keyFile: createRunpodKeyFile(runpodAccess),
    gateway: {
      createRunpodClient: () =>
        ({
          async verifyKey() {
            if (opts.runpodError) throw opts.runpodError;
            if (opts.runpodAccepts === false) throw new DomainError({ code: "media_credentials_invalid", message: "RunPod rejected the API key (HTTP 401)." });
            return { ok: true as const };
          },
        }) as unknown as RunpodApiClient,
      createS3Client: () => ({}) as RunpodS3Client,
    },
    clock: { now: () => new Date("2026-10-16T00:00:00Z") },
  });

  let creds: StoredGeminiCredentials | null = null;
  let geminiKeyText: string | null = null;
  const geminiAccess: KeyFileAccess = {
    read: async () => geminiKeyText,
    write: async (c) => {
      geminiKeyText = JSON.stringify(c);
    },
    remove: async () => {
      geminiKeyText = null;
    },
    randomBytes: (n) => Buffer.alloc(n, 3),
  };
  const geminiStore = {
    getCredentials: async () => creds,
    upsertCredentials: async (input: Omit<StoredGeminiCredentials, "id" | "updatedAt">) => {
      creds = { id: "default", ...input, updatedAt: new Date("2026-10-16T00:00:00Z") };
    },
    setCredentialsStatus: async () => true,
    clearCredentials: async () => {
      creds = null;
    },
  } as unknown as GeminiStore;
  const googleChecks: string[] = [];
  const gemini = createGeminiMediaServices({
    store: geminiStore,
    api: {
      checkKey: async (key: string) => {
        googleChecks.push(key);
        if (opts.googleRefuses) throw new DomainError({ code: "gemini_key_invalid", message: "Google refused the API key (HTTP 400)" });
      },
    },
    keyFile: createKeyFile(geminiAccess, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
    clock: { now: () => new Date("2026-10-16T00:00:00Z") },
  } as unknown as GeminiMediaDeps);

  const transfer = createCloudCredentialsTransfer({ sections: cloudCredentialSections(() => media, () => gemini), clock: { now: () => new Date("2026-10-16T00:00:00Z") }, passwordScrypt: FAST });
  const routes = { getSession: async () => ({ user: { id: "owner" } }), transfer };
  return {
    media,
    gemini,
    googleChecks,
    exportFile: (password = PASSWORD) => createCloudCredentialsExportPostHandler(routes)(post({ password })),
    importFile: (file: unknown, password = PASSWORD) => createCloudCredentialsImportPostHandler(routes)(post({ file, password })),
    anonymous: { getSession: async () => null, transfer },
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/cloud-credentials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const noSecretIn = (text: string) => ![RUNPOD_KEY, S3_SECRET, GEMINI_KEY, OTHER_GEMINI_KEY, PASSWORD].some((secret) => text.includes(secret));

test("one file carries RunPod, S3 and Gemini to another computer; no file or response carries a key or the password", async () => {
  const a = computer();
  await a.media.setCredentials({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_1", s3SecretAccessKey: S3_SECRET });
  await a.gemini.setKey({ apiKey: GEMINI_KEY });
  const exported = await a.exportFile();
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.ok(noSecretIn(text));
  const { file, skipped } = JSON.parse(text);
  assert.equal(file.format, "ytm-cloud-credentials");
  assert.deepEqual(file.sections, ["runpod", "gemini"]);
  assert.deepEqual(file.hints, { runpodKeyPrefix: "rpa_SECR…", s3AccessKeyId: "user_1", geminiKeyHint: "ET42" });
  assert.deepEqual(skipped, []);

  const b = computer();
  const imported = await b.importFile(file);
  assert.equal(imported.status, 200);
  assert.ok(noSecretIn(await imported.text()));
  // The keys themselves arrived intact: B holds exactly what A held.
  assert.deepEqual(await b.media.exportCredentialsForTransfer(), { runpodApiKey: RUNPOD_KEY, s3AccessKeyId: "user_1", s3SecretAccessKey: S3_SECRET });
  assert.equal(await b.gemini.exportKeyForTransfer(), GEMINI_KEY);
  assert.deepEqual(b.googleChecks, [GEMINI_KEY], "the Gemini key was checked with Google before it was stored");
});

test("BL-137's RunPod-only file still imports, and leaves the Gemini key stored on this computer untouched", async () => {
  const legacyFile = {
    format: "ytm-runpod-credentials",
    version: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
    hints: { runpodKeyPrefix: "rpa_SECR…", s3AccessKeyId: null },
    encrypted: await encryptWithPassword(JSON.stringify({ runpodApiKey: RUNPOD_KEY, s3AccessKeyId: null, s3SecretAccessKey: null }), PASSWORD, FAST),
  };
  const b = computer();
  await b.gemini.setKey({ apiKey: OTHER_GEMINI_KEY });
  b.googleChecks.length = 0;
  const res = await b.importFile(legacyFile);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(await res.text()).imported), ["runpod"]);
  assert.equal((await b.media.exportCredentialsForTransfer())?.runpodApiKey, RUNPOD_KEY);
  assert.equal(await b.gemini.exportKeyForTransfer(), OTHER_GEMINI_KEY);
  assert.deepEqual(b.googleChecks, [], "Google is not even asked: the file has no Gemini key");
});

test("a Gemini-only file (a computer without RunPod) imports the Gemini key and leaves RunPod's stored keys untouched", async () => {
  const a = computer();
  await a.gemini.setKey({ apiKey: GEMINI_KEY });
  const { file } = JSON.parse(await (await a.exportFile()).text());
  assert.deepEqual(file.sections, ["gemini"]);
  assert.deepEqual(file.hints, { runpodKeyPrefix: null, s3AccessKeyId: null, geminiKeyHint: "ET42" });
  const b = computer();
  await b.media.setCredentials({ runpodApiKey: "rpa_ALREADYHEREALREADYHERE0000" });
  assert.equal((await b.importFile(file)).status, 200);
  assert.equal(await b.gemini.exportKeyForTransfer(), GEMINI_KEY);
  assert.equal((await b.media.exportCredentialsForTransfer())?.runpodApiKey, "rpa_ALREADYHEREALREADYHERE0000");
});

test("a wrong password, a damaged file, or a key either provider refuses changes nothing -- on both sides", async () => {
  const a = computer();
  await a.media.setCredentials({ runpodApiKey: RUNPOD_KEY });
  await a.gemini.setKey({ apiKey: GEMINI_KEY });
  const { file } = JSON.parse(await (await a.exportFile()).text());
  const nothingStored = async (c: ReturnType<typeof computer>) => {
    assert.deepEqual(await c.media.getCredentialsStatus(), { configured: false, reason: "no_credentials" });
    assert.equal((await c.gemini.getKey()).configured, false);
  };

  const b = computer();
  const wrong = await b.importFile(file, "not the password");
  assert.equal(wrong.status, 400);
  assert.match(JSON.parse(await wrong.text()).message, /Wrong password/);
  const tampered = { ...file, encrypted: { ...file.encrypted, authTag: Buffer.alloc(16, 7).toString("base64") } };
  assert.equal((await b.importFile(tampered)).status, 400);
  assert.equal(JSON.parse(await (await b.importFile({ format: "something-else" })).text()).error, "validation_failed");
  await nothingStored(b);

  // Google refuses the Gemini key: RunPod's key (accepted) is not stored either.
  const googleNo = computer({ googleRefuses: true });
  const refused = await googleNo.importFile(file);
  const body = JSON.parse(await refused.text());
  assert.equal(body.error, "gemini_key_invalid");
  assert.ok(noSecretIn(JSON.stringify(body)));
  await nothingStored(googleNo);

  // RunPod refuses its key: Gemini is not stored, and Google is not even asked.
  const runpodNo = computer({ runpodAccepts: false });
  assert.equal(JSON.parse(await (await runpodNo.importFile(file)).text()).error, "media_credentials_invalid");
  assert.deepEqual(runpodNo.googleChecks, []);
  await nothingStored(runpodNo);

  // RunPod unreachable keeps its own reason (BL-137 review), and nothing is stored.
  const offline = computer({ runpodError: new DomainError({ code: "media_gateway_disabled", message: "The media gateway is switched off." }) });
  assert.equal(JSON.parse(await (await offline.importFile(file)).text()).error, "media_gateway_disabled");
  await nothingStored(offline);
});

test("export needs a session, a stored key, and a password of at least 12 characters; import needs a session", async () => {
  const a = computer();
  assert.equal((await createCloudCredentialsExportPostHandler(a.anonymous)(post({ password: PASSWORD }))).status, 401);
  assert.equal((await createCloudCredentialsImportPostHandler(a.anonymous)(post({ file: {}, password: "x" }))).status, 401);
  const none = await a.exportFile();
  assert.equal(none.status, 409);
  assert.equal(JSON.parse(await none.text()).error, "cloud_credentials_not_configured");
  await a.gemini.setKey({ apiKey: GEMINI_KEY });
  assert.equal(JSON.parse(await (await a.exportFile("elevenchars")).text()).error, "validation_failed");
  assert.equal((await a.exportFile("twelve chars")).status, 200);
});
