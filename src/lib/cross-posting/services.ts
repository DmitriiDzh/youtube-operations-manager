import type { DeviceSecretSlot } from "@/lib/device-secrets";
import type { EncryptedPayload } from "@/lib/shared-crypto";
import type { MetaClient, MetaPage } from "@/lib/social-gateway";
import { CONNECT_STATE_TTL_MS, DomainError, META_POSTING_SCOPES, type AccountCheck, type AccountCheckProblem, PENDING_PICK_TTL_MS, notConfigured, type MetaAppStatus, type PendingPageView, type SocialAccountRow, type SocialAccountView, type SocialNetwork } from "./contracts";
import type { SocialJob } from "./runner";
import { FACEBOOK_REEL, INSTAGRAM_REEL } from "./limits";
import { disconnectInputSchema, parseWithSchema, selectPageInputSchema, setMetaAppInputSchema, startConnectInputSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-252 (ADR 0068) stage 1: the Meta app and connecting a channel's Facebook Page + Instagram professional account.
//   1. startConnect(channel, redirectUri) -> Meta's consent URL with a single-use random `state` (15 min).
//   2. Meta redirects the owner's browser to the callback with `code` + `state`; completeConnect consumes the state (a state is
//      accepted once, only for the redirect URI it was made for), exchanges the code for a long-lived user token and lists the
//      Pages. The Pages (with their tokens) wait in memory for the owner's pick under a random pick id (15 min).
//   3. selectPage(pickId, pageId) seals the Page token with this computer's key and stores the Page (facebook) and its linked
//      Instagram account (instagram) for that channel. The user token is never stored.
// Nothing here posts anything (stage 2). No token ever leaves this module except sealed into `social_accounts`.
// ---------------------------------------------------------------------------

export type CrossPostingStore = {
  channelExists(channelId: string): Promise<boolean>;
  list(channelId: string | null): Promise<SocialAccountRow[]>;
  upsert(row: SocialAccountRow): Promise<void>;
  remove(channelId: string, network: SocialNetwork | null): Promise<number>;
};

export type PostingSettings = { enabled: boolean };

export type CrossPostingDeps = {
  store: CrossPostingStore;
  appSecret: Pick<DeviceSecretSlot, "read" | "write" | "clear" | "info">;
  sealer: { seal(plaintext: string): Promise<EncryptedPayload | null>; open(payload: EncryptedPayload): Promise<string | null> };
  meta: Pick<MetaClient, "authorizeUrl" | "exchangeCode" | "listPages" | "inspectPageToken"> & Partial<Pick<MetaClient, "igPublishingUsage">>;
  /** This computer's switch «Публикация в соцсети» (app_settings JSON; off by default). */
  settings?: { read(): Promise<string | null>; write(json: string): Promise<void> };
  /** This computer's cross-posting jobs (for the screen, retries and the Facebook 24 h count). */
  jobs?: { list(channelId: string | null): Promise<SocialJob[]>; get(jobId: string): Promise<SocialJob | null>; remove(jobId: string): Promise<void> };
  now: () => number;
  randomId: () => string;
};

type ConnectState = { channelId: string; redirectUri: string; expiresAt: number };
type PendingPick = { channelId: string; pages: MetaPage[]; expiresAt: number };

function view(row: SocialAccountRow): SocialAccountView {
  return { channelId: row.channelId, network: row.network, externalId: row.externalId, displayName: row.displayName, username: row.username, pageId: row.pageId, tokenExpiresAt: row.tokenExpiresAt, connectedAt: row.connectedAt };
}

export function createCrossPostingServices(deps: CrossPostingDeps) {
  const states = new Map<string, ConnectState>();
  const picks = new Map<string, PendingPick>();

  function sweep() {
    const now = deps.now();
    for (const [k, v] of states) if (v.expiresAt <= now) states.delete(k);
    for (const [k, v] of picks) if (v.expiresAt <= now) picks.delete(k);
  }

  async function readApp(): Promise<{ appId: string; appSecret: string }> {
    const raw = await deps.appSecret.read();
    if (!raw) throw notConfigured();
    try {
      const parsed = JSON.parse(raw) as { appId?: unknown; appSecret?: unknown };
      if (typeof parsed.appId === "string" && typeof parsed.appSecret === "string") return { appId: parsed.appId, appSecret: parsed.appSecret };
    } catch {
      // fall through
    }
    throw notConfigured();
  }

  async function openToken(sealedJson: string): Promise<string> {
    let payload: EncryptedPayload | null = null;
    try {
      payload = JSON.parse(sealedJson) as EncryptedPayload;
    } catch {
      payload = null;
    }
    const token = payload ? await deps.sealer.open(payload) : null;
    if (!token) throw new DomainError({ code: "device_secret_unreadable", message: "The stored token does not open with this computer's key; connect the account again." });
    return token;
  }

  async function requireChannel(channelId: string) {
    if (!(await deps.store.channelExists(channelId))) throw new DomainError({ code: "not_found", message: `Channel ${channelId} is not connected here.`, details: { channelId } });
  }

  const api = {
    async getMetaApp(): Promise<MetaAppStatus> {
      const info = await deps.appSecret.info();
      return { configured: Boolean(info), appId: info?.hints.appId ?? null };
    },

    /** Saved as typed; Meta checks it on the first connect (a wrong secret fails the code exchange with Meta's own message). */
    async setMetaApp(raw: unknown): Promise<MetaAppStatus> {
      const input = parseWithSchema(setMetaAppInputSchema, raw, "Meta app");
      await deps.appSecret.write(JSON.stringify({ appId: input.appId, appSecret: input.appSecret.toLowerCase() }), { hints: { appId: input.appId } });
      return { configured: true, appId: input.appId };
    },

    async clearMetaApp(): Promise<MetaAppStatus> {
      await deps.appSecret.clear();
      return { configured: false, appId: null };
    },

    async startConnect(raw: unknown, redirectUri: string): Promise<{ authorizeUrl: string }> {
      const input = parseWithSchema(startConnectInputSchema, raw, "connect request");
      await requireChannel(input.channelId);
      const app = await readApp();
      sweep();
      const state = deps.randomId();
      states.set(state, { channelId: input.channelId, redirectUri, expiresAt: deps.now() + CONNECT_STATE_TTL_MS });
      return { authorizeUrl: deps.meta.authorizeUrl({ appId: app.appId, redirectUri, state }) };
    },

    /** The callback: the state must be one this process issued, unexpired, for this same redirect URI; it is used up either way. */
    async completeConnect(input: { state: string | null; code: string | null; redirectUri: string }): Promise<{ pickId: string; channelId: string }> {
      sweep();
      const entry = input.state ? states.get(input.state) : undefined;
      if (input.state) states.delete(input.state);
      if (!entry || entry.redirectUri !== input.redirectUri) throw new DomainError({ code: "unauthorized", message: "This connect link is unknown or expired. Start the connection again from Settings." });
      if (!input.code) throw new DomainError({ code: "social_request_rejected", message: "Meta returned no authorization code (the consent was cancelled?)." });
      const app = await readApp();
      const { userToken } = await deps.meta.exchangeCode({ appId: app.appId, appSecret: app.appSecret, redirectUri: input.redirectUri, code: input.code });
      const pages = await deps.meta.listPages(userToken);
      const pickId = deps.randomId();
      picks.set(pickId, { channelId: entry.channelId, pages, expiresAt: deps.now() + PENDING_PICK_TTL_MS });
      return { pickId, channelId: entry.channelId };
    },

    getPick(pickId: string): { channelId: string; pages: PendingPageView[] } {
      sweep();
      const pick = picks.get(pickId);
      if (!pick) throw new DomainError({ code: "not_found", message: "This choice has expired. Start the connection again." });
      return { channelId: pick.channelId, pages: pick.pages.map((p) => ({ pageId: p.pageId, pageName: p.pageName, instagram: p.instagram ? { igUserId: p.instagram.igUserId, username: p.instagram.username } : null })) };
    },

    async selectPage(raw: unknown): Promise<SocialAccountView[]> {
      const input = parseWithSchema(selectPageInputSchema, raw, "page choice");
      sweep();
      const pick = picks.get(input.pickId);
      if (!pick) throw new DomainError({ code: "not_found", message: "This choice has expired. Start the connection again." });
      const page = pick.pages.find((p) => p.pageId === input.pageId);
      if (!page) throw new DomainError({ code: "validation_failed", message: "That Page was not among the ones Meta returned." });
      // Used up before any await (review 14.11): two concurrent picks must not both store, interleaving Page A and Page B rows.
      picks.delete(input.pickId);
      await requireChannel(pick.channelId);
      const sealed = await deps.sealer.seal(page.pageToken);
      if (!sealed) throw new DomainError({ code: "device_secret_unreadable", message: "This computer's secrets key is not available; the token cannot be stored." });
      const now = deps.now();
      const tokenSealed = JSON.stringify(sealed);
      const base = { channelId: pick.channelId, pageId: page.pageId, tokenSealed, tokenExpiresAt: null, connectedAt: now };
      await deps.store.upsert({ ...base, network: "facebook", externalId: page.pageId, displayName: page.pageName, username: null });
      if (page.instagram) await deps.store.upsert({ ...base, network: "instagram", externalId: page.instagram.igUserId, displayName: page.instagram.username ?? page.pageName, username: page.instagram.username });
      else await deps.store.remove(pick.channelId, "instagram");
      return (await deps.store.list(pick.channelId)).map(view);
    },

    /**
     * AC-XP-8 identity read: asks Meta what the stored Page token is (valid? scopes?) and which Page / Instagram account it reaches,
     * and compares that with what this channel stored. Read-only; the token is opened here and never leaves the module.
     */
    async checkAccounts(channelId: string): Promise<AccountCheck> {
      const rows = await deps.store.list(channelId);
      const fb = rows.find((r) => r.network === "facebook");
      if (!fb || !fb.pageId) throw new DomainError({ code: "not_found", message: `Channel ${channelId} has no connected Facebook Page.`, details: { channelId } });
      const ig = rows.find((r) => r.network === "instagram") ?? null;
      const app = await readApp();
      const token = await openToken(fb.tokenSealed);
      const live = await deps.meta.inspectPageToken({ appId: app.appId, appSecret: app.appSecret, pageId: fb.pageId, pageToken: token });
      const problems: AccountCheckProblem[] = [];
      const missingScopes = META_POSTING_SCOPES.filter((s) => !live.scopes.includes(s));
      if (!live.valid) problems.push("token_invalid");
      else {
        if (missingScopes.length) problems.push("scope_missing");
        if (live.page?.pageId !== fb.externalId) problems.push("page_mismatch");
        if (ig && !live.instagram) problems.push("instagram_unlinked");
        else if (ig && live.instagram && live.instagram.igUserId !== ig.externalId) problems.push("instagram_mismatch");
      }
      return {
        channelId,
        checkedAt: deps.now(),
        ok: problems.length === 0,
        problems,
        missingScopes: live.valid ? missingScopes : [],
        scopes: live.scopes,
        tokenExpiresAt: live.expiresAt,
        facebook: { stored: fb.externalId, live: live.page?.pageId ?? null, name: live.page?.pageName ?? null },
        instagram: ig || live.instagram ? { stored: ig?.externalId ?? null, live: live.instagram?.igUserId ?? null, username: live.instagram?.username ?? null } : null,
      };
    },

    async getPostingSettings(): Promise<PostingSettings> {
      const raw = deps.settings ? await deps.settings.read() : null;
      try {
        return { enabled: raw ? (JSON.parse(raw) as { enabled?: unknown }).enabled === true : false };
      } catch {
        return { enabled: false };
      }
    },

    async setPostingSettings(raw: unknown): Promise<PostingSettings> {
      const enabled = (raw as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== "boolean") throw new DomainError({ code: "validation_failed", message: "enabled must be true or false" });
      if (!deps.settings) throw new DomainError({ code: "social_not_configured", message: "The posting switch is not available here." });
      await deps.settings.write(JSON.stringify({ enabled }));
      return { enabled };
    },

    /**
     * The runner's port (AC-XP-8): the channel's Page token and ids, only after Meta's live answer matches what is stored (every
     * posting scope, the same Page and Instagram). Never leaves this module except to the gateway through the runner.
     */
    async postingTarget(channelId: string): Promise<{ token: string; pageId: string; igUserId: string | null }> {
      const check = await api.checkAccounts(channelId);
      if (!check.ok) throw new DomainError({ code: "social_account_mismatch", message: `The connected Meta accounts did not pass the check (${check.problems.join(", ")}).`, details: { channelId, problems: check.problems } });
      const rows = await deps.store.list(channelId);
      const fb = rows.find((r) => r.network === "facebook")!;
      const ig = rows.find((r) => r.network === "instagram") ?? null;
      return { token: await openToken(fb.tokenSealed), pageId: fb.pageId ?? fb.externalId, igUserId: ig?.externalId ?? null };
    },

    /**
     * AC-XP-16: whether one more post fits the network's rolling 24 h limit -- Instagram as Meta counts it (`content_publishing_limit`),
     * a Facebook Page by this computer's own published Reels. Unknown counts as fitting only for Facebook (our own count is exact).
     */
    async quota(channelId: string): Promise<{ instagram: { used: number | null; limit: number }; facebook: { used: number; limit: number } }> {
      const since = deps.now() - 24 * 60 * 60_000;
      const jobs = deps.jobs ? await deps.jobs.list(channelId) : [];
      const fbUsed = jobs.filter((j) => j.network === "facebook" && j.status === "published" && j.updatedAt >= since).length;
      let igUsed: number | null = null;
      const ig = (await deps.store.list(channelId)).find((r) => r.network === "instagram");
      if (ig && deps.meta.igPublishingUsage) {
        const fb = (await deps.store.list(channelId)).find((r) => r.network === "facebook");
        if (fb) igUsed = await deps.meta.igPublishingUsage({ igUserId: ig.externalId, token: await openToken(fb.tokenSealed) }).catch(() => null);
      }
      return { instagram: { used: igUsed, limit: INSTAGRAM_REEL.postsPer24h }, facebook: { used: fbUsed, limit: FACEBOOK_REEL.postsPer24h } };
    },

    async listJobs(channelId: string | null): Promise<SocialJob[]> {
      return deps.jobs ? deps.jobs.list(channelId) : [];
    },

    /** The owner's retry of a failed job that never got a post id: the job is forgotten, the runner starts it again if still due. */
    async retryJob(raw: unknown): Promise<{ retried: boolean }> {
      const jobId = (raw as { jobId?: unknown } | null)?.jobId;
      if (typeof jobId !== "string" || !jobId) throw new DomainError({ code: "validation_failed", message: "jobId is required" });
      const job = deps.jobs ? await deps.jobs.get(jobId) : null;
      if (!job) throw new DomainError({ code: "not_found", message: "No such job on this computer." });
      if (job.status !== "failed" || job.remotePostId) throw new DomainError({ code: "validation_failed", message: "Only a failed job without a published post can be retried." });
      await deps.jobs!.remove(jobId);
      return { retried: true };
    },

    async listAccounts(channelId: string | null): Promise<SocialAccountView[]> {
      return (await deps.store.list(channelId)).map(view);
    },

    async disconnect(raw: unknown): Promise<{ removed: number }> {
      const input = parseWithSchema(disconnectInputSchema, raw, "disconnect request");
      return { removed: await deps.store.remove(input.channelId, input.network ?? null) };
    },
  };
  return api;
}

export type CrossPostingCore = ReturnType<typeof createCrossPostingServices>;
