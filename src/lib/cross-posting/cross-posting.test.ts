import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { MetaClient, MetaPage, MetaTokenInspection } from "@/lib/social-gateway";
import { createCrossPostingServices, type CrossPostingStore, type SocialAccountRow } from "./index";

// BL-252 (ADR 0068, CROSS_POSTING_PLAN.md stage 1) acceptance:
//  AC-1 the App Secret is stored only in the device secret and never returned (only the App ID);
//  AC-2 a connect needs a known channel and a saved app; the consent URL carries a fresh single-use state;
//  AC-3 the callback accepts a state once, only unexpired (15 min) and only for the redirect URI it was issued for;
//  AC-4 after consent the owner picks one Page; it is stored for THAT channel (Page + its Instagram), the token sealed, never listed;
//  AC-5 a pick expires after 15 minutes and is single-use; a Page not offered is refused; disconnect removes rows.

const APP = { appId: "1234567890", appSecret: "0123456789abcdef0123456789ABCDEF" };
const REDIRECT = "http://localhost:3000/api/social/meta/callback";
const PAGES: MetaPage[] = [
  { pageId: "111", pageName: "WWE", pageToken: "PAGE-TOKEN-1", instagram: { igUserId: "1784", username: "wwexplained", pictureUrl: null } },
  { pageId: "222", pageName: "Plain", pageToken: "PAGE-TOKEN-2", instagram: null },
];

function harness() {
  let now = 1_000_000;
  let n = 0;
  let secret: { plaintext: string; hints: Record<string, string | null> } | null = null;
  const rows: SocialAccountRow[] = [];
  const exchanged: Array<{ code: string; redirectUri: string; appSecret: string }> = [];
  const inspected: Array<{ pageId: string; pageToken: string }> = [];
  let inspection: MetaTokenInspection = {
    valid: true,
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"],
    expiresAt: null,
    page: { pageId: "111", pageName: "WWE" },
    instagram: { igUserId: "1784", username: "wwexplained" },
  };
  const store: CrossPostingStore = {
    channelExists: async (id) => id === "UC1" || id === "UC2",
    list: async (id) => rows.filter((r) => id === null || r.channelId === id),
    upsert: async (row) => {
      const i = rows.findIndex((r) => r.channelId === row.channelId && r.network === row.network);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    remove: async (id, network) => {
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].channelId === id && (network === null || rows[i].network === network)) {
          rows.splice(i, 1);
          removed++;
        }
      return removed;
    },
  };
  const meta: Pick<MetaClient, "authorizeUrl" | "exchangeCode" | "listPages" | "inspectPageToken"> = {
    authorizeUrl: ({ appId, redirectUri, state, configId }) => `https://meta.test/dialog?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}${configId ? `&config_id=${configId}` : ""}`,
    exchangeCode: async (input) => (exchanged.push(input), { userToken: "USER-TOKEN", expiresAt: null }),
    listPages: async () => PAGES,
    inspectPageToken: async (input) => (inspected.push({ pageId: input.pageId, pageToken: input.pageToken }), inspection),
  };
  const core = createCrossPostingServices({
    store,
    appSecret: {
      read: async () => secret?.plaintext ?? null,
      write: async (plaintext, input) => ((secret = { plaintext, hints: input.hints }), { hints: input.hints, status: null, verifiedAt: null, updatedAt: now, version: "v" }),
      clear: async () => void (secret = null),
      info: async () => (secret ? { hints: secret.hints, status: null, verifiedAt: null, updatedAt: now, version: "v" } : null),
    },
    sealer: {
      seal: async (plaintext) => ({ ciphertext: Buffer.from(`sealed:${plaintext}`).toString("base64"), iv: "iv", authTag: "tag" }),
      open: async (payload) => {
        const text = Buffer.from(payload.ciphertext, "base64").toString();
        return text.startsWith("sealed:") ? text.slice("sealed:".length) : null;
      },
    },
    meta,
    now: () => now,
    randomId: () => `random-id-${String(++n).padStart(8, "0")}`,
  });
  return { core, rows, exchanged, inspected, setInspection: (i: MetaTokenInspection) => (inspection = i), advance: (ms: number) => (now += ms), getSecret: () => secret };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
const isCode = (code: string) => (e: unknown) => e instanceof DomainError && e.code === code;

test("AC-1: the App Secret goes only into the device secret; status shows the App ID only; bad shapes refused", async () => {
  const h = harness();
  // 2026-11-15 (requirement added: the FLfB configuration id is shown too; it is public, not a secret): configId in the status.
  assert.deepEqual(await h.core.getMetaApp(), { configured: false, appId: null, configId: null });
  assert.deepEqual(await h.core.setMetaApp(APP), { configured: true, appId: "1234567890", configId: null });
  assert.deepEqual(JSON.parse(h.getSecret()!.plaintext), { appId: "1234567890", appSecret: "0123456789abcdef0123456789abcdef" });
  const status = await h.core.getMetaApp();
  assert.deepEqual(status, { configured: true, appId: "1234567890", configId: null });
  assert.ok(!JSON.stringify(status).includes("0123456789abcdef"));
  await assert.rejects(h.core.setMetaApp({ appId: "abc", appSecret: APP.appSecret }), isCode("validation_failed"));
  await assert.rejects(h.core.setMetaApp({ appId: APP.appId, appSecret: "short" }), isCode("validation_failed"));
  await assert.rejects(h.core.setMetaApp({ ...APP, extra: 1 }), isCode("validation_failed"));
  assert.deepEqual(await h.core.clearMetaApp(), { configured: false, appId: null, configId: null });
  assert.equal(h.getSecret(), null);
});

test("AC-2: connect needs the app saved and a known channel; each connect gets its own state", async () => {
  const h = harness();
  await assert.rejects(h.core.startConnect({ channelId: "UC1" }, REDIRECT), isCode("social_not_configured"));
  await h.core.setMetaApp(APP);
  await assert.rejects(h.core.startConnect({ channelId: "UC-unknown" }, REDIRECT), isCode("not_found"));
  const a = await h.core.startConnect({ channelId: "UC1" }, REDIRECT);
  const b = await h.core.startConnect({ channelId: "UC1" }, REDIRECT);
  assert.equal(new URL(a.authorizeUrl).searchParams.get("client_id"), "1234567890");
  assert.equal(new URL(a.authorizeUrl).searchParams.get("redirect_uri"), REDIRECT);
  assert.notEqual(stateOf(a.authorizeUrl), stateOf(b.authorizeUrl));
});

test("AC-3: a state works once, not after 15 minutes, not for another redirect URI, not when absent", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  const s1 = stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl);
  const ok = await h.core.completeConnect({ state: s1, code: "CODE", redirectUri: REDIRECT });
  assert.equal(ok.channelId, "UC1");
  assert.deepEqual(h.exchanged, [{ appId: APP.appId, appSecret: APP.appSecret.toLowerCase(), redirectUri: REDIRECT, code: "CODE" }]);
  await assert.rejects(h.core.completeConnect({ state: s1, code: "CODE", redirectUri: REDIRECT }), isCode("unauthorized"));

  const s2 = stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl);
  h.advance(15 * 60_000);
  await assert.rejects(h.core.completeConnect({ state: s2, code: "CODE", redirectUri: REDIRECT }), isCode("unauthorized"));

  const s3 = stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl);
  await assert.rejects(h.core.completeConnect({ state: s3, code: "CODE", redirectUri: "https://evil.example/cb" }), isCode("unauthorized"));
  // ...and that wrong try used it up.
  await assert.rejects(h.core.completeConnect({ state: s3, code: "CODE", redirectUri: REDIRECT }), isCode("unauthorized"));
  await assert.rejects(h.core.completeConnect({ state: null, code: "CODE", redirectUri: REDIRECT }), isCode("unauthorized"));
  assert.equal(h.exchanged.length, 1);
});

test("AC-4: the picked Page and its Instagram are stored for the channel the connect began for; tokens sealed, never listed", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  const state = stateOf((await h.core.startConnect({ channelId: "UC2" }, REDIRECT)).authorizeUrl);
  const { pickId } = await h.core.completeConnect({ state, code: "C", redirectUri: REDIRECT });
  const pick = h.core.getPick(pickId);
  assert.equal(pick.channelId, "UC2");
  assert.deepEqual(pick.pages, [
    { pageId: "111", pageName: "WWE", instagram: { igUserId: "1784", username: "wwexplained" } },
    { pageId: "222", pageName: "Plain", instagram: null },
  ]);
  assert.ok(!JSON.stringify(pick).includes("PAGE-TOKEN"));
  const accounts = await h.core.selectPage({ pickId, pageId: "111" });
  assert.deepEqual(
    accounts.map((a) => [a.channelId, a.network, a.externalId, a.displayName, a.username, a.pageId]),
    [
      ["UC2", "facebook", "111", "WWE", null, "111"],
      ["UC2", "instagram", "1784", "wwexplained", "wwexplained", "111"],
    ]
  );
  assert.ok(!JSON.stringify(accounts).includes("PAGE-TOKEN") && !JSON.stringify(accounts).includes("tokenSealed"));
  for (const row of h.rows) {
    assert.ok(!row.tokenSealed.includes("PAGE-TOKEN-1"));
    assert.equal(Buffer.from(JSON.parse(row.tokenSealed).ciphertext, "base64").toString(), "sealed:PAGE-TOKEN-1");
  }
  assert.ok(!h.rows.some((r) => r.tokenSealed.includes("USER-TOKEN")));
});

test("AC-4b: re-connecting to a Page without Instagram replaces the Page and drops the old Instagram row", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  for (const pageId of ["111", "222"]) {
    const state = stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl);
    const { pickId } = await h.core.completeConnect({ state, code: "C", redirectUri: REDIRECT });
    await h.core.selectPage({ pickId, pageId });
  }
  assert.deepEqual((await h.core.listAccounts("UC1")).map((a) => [a.network, a.externalId]), [["facebook", "222"]]);
});

test("AC-5: a pick is single-use, expires after 15 minutes, refuses a Page not offered; disconnect removes rows", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  const connect = async () => (await h.core.completeConnect({ state: stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl), code: "C", redirectUri: REDIRECT })).pickId;

  const p1 = await connect();
  await assert.rejects(h.core.selectPage({ pickId: p1, pageId: "999" }), isCode("validation_failed"));
  await h.core.selectPage({ pickId: p1, pageId: "111" });
  await assert.rejects(h.core.selectPage({ pickId: p1, pageId: "111" }), isCode("not_found"));

  const p2 = await connect();
  h.advance(15 * 60_000);
  assert.throws(() => h.core.getPick(p2), isCode("not_found"));
  await assert.rejects(h.core.selectPage({ pickId: p2, pageId: "111" }), isCode("not_found"));

  assert.deepEqual(await h.core.disconnect({ channelId: "UC1", network: "instagram" }), { removed: 1 });
  assert.deepEqual((await h.core.listAccounts("UC1")).map((a) => a.network), ["facebook"]);
  assert.deepEqual(await h.core.disconnect({ channelId: "UC1" }), { removed: 1 });
  assert.deepEqual(await h.core.listAccounts(null), []);
});

// AC-XP-8 (CROSS_POSTING_PLAN.md): before anything is posted, Meta's live answer about the stored token must match what the channel
// stored -- the same Page, the same Instagram account, every posting scope; otherwise posting is refused (fail closed).
async function connected(pageId = "111") {
  const h = harness();
  await h.core.setMetaApp(APP);
  const state = stateOf((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl);
  const { pickId } = await h.core.completeConnect({ state, code: "C", redirectUri: REDIRECT });
  await h.core.selectPage({ pickId, pageId });
  return h;
}

test("AC-XP-8: the identity read opens the stored Page token, asks Meta, and is ok when Page, Instagram and scopes match", async () => {
  const h = await connected();
  const check = await h.core.checkAccounts("UC1");
  assert.deepEqual(h.inspected, [{ pageId: "111", pageToken: "PAGE-TOKEN-1" }]);
  assert.equal(check.ok, true);
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.facebook, { stored: "111", live: "111", name: "WWE" });
  assert.deepEqual(check.instagram, { stored: "1784", live: "1784", username: "wwexplained" });
  assert.ok(!JSON.stringify(check).includes("PAGE-TOKEN"));
});

test("AC-XP-8: a missing posting scope, another Page, another or unlinked Instagram, or an invalid token each fail the check", async () => {
  const base = { valid: true, scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"], expiresAt: null, page: { pageId: "111", pageName: "WWE" }, instagram: { igUserId: "1784", username: "w" } };
  const cases: Array<[MetaTokenInspection, string[], string[]]> = [
    [{ ...base, scopes: base.scopes.filter((s) => s !== "instagram_content_publish") }, ["scope_missing"], ["instagram_content_publish"]],
    [{ ...base, page: { pageId: "999", pageName: "Other" } }, ["page_mismatch"], []],
    [{ ...base, instagram: { igUserId: "555", username: "x" } }, ["instagram_mismatch"], []],
    [{ ...base, instagram: null }, ["instagram_unlinked"], []],
    [{ valid: false, scopes: [], expiresAt: null, page: null, instagram: null }, ["token_invalid"], []],
  ];
  for (const [inspection, problems, missing] of cases) {
    const h = await connected();
    h.setInspection(inspection);
    const check = await h.core.checkAccounts("UC1");
    assert.equal(check.ok, false);
    assert.deepEqual(check.problems, problems);
    assert.deepEqual(check.missingScopes, missing);
  }
});

test("AC-XP-8: no connected Page -> not_found; a token that does not open with this computer's key -> device_secret_unreadable", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  await assert.rejects(h.core.checkAccounts("UC1"), isCode("not_found"));
  const c = await connected();
  for (const row of c.rows) row.tokenSealed = JSON.stringify({ ciphertext: Buffer.from("garbage").toString("base64"), iv: "iv", authTag: "tag" });
  await assert.rejects(c.core.checkAccounts("UC1"), isCode("device_secret_unreadable"));
});

// 2026-11-15 (Instagram refuses resumable uploads from apps without Facebook Login for Business): the owner saves the app's FLfB
// configuration id. It is stored with the app WITHOUT re-entering or changing the secret, the connect dialog then carries
// config_id and no scope, and removing it goes back to the scopes.
test("FLfB configuration: saved beside the app (secret unchanged), used by the connect dialog, removable", async () => {
  const h = harness();
  await h.core.setMetaApp(APP);
  const secretBefore = JSON.parse(h.getSecret()!.plaintext).appSecret;
  assert.deepEqual(await h.core.setMetaConfig({ configId: "1234567890123456" }), { configured: true, appId: "1234567890", configId: "1234567890123456" });
  const stored = JSON.parse(h.getSecret()!.plaintext);
  assert.equal(stored.appSecret, secretBefore);
  assert.equal(stored.configId, "1234567890123456");
  assert.equal((await h.core.getMetaApp()).configId, "1234567890123456");
  assert.equal(new URL((await h.core.startConnect({ channelId: "UC1" }, REDIRECT)).authorizeUrl).searchParams.get("config_id"), "1234567890123456");
  await assert.rejects(h.core.setMetaConfig({ configId: "abc" }), isCode("validation_failed"));
  assert.deepEqual(await h.core.setMetaConfig({ configId: null }), { configured: true, appId: "1234567890", configId: null });
  assert.equal(JSON.parse(h.getSecret()!.plaintext).configId, undefined);
});
