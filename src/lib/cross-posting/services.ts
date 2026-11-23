import type { DeviceSecretSlot } from "@/lib/device-secrets";
import type { EncryptedPayload } from "@/lib/shared-crypto";
import type { MetaClient, MetaPage, MetaTokenInspection } from "@/lib/social-gateway";
import { CONNECT_STATE_TTL_MS, DomainError, META_NETWORK_SCOPES, type AccountCheck, type AccountCheckProblem, type NetworkAccountCheck, PENDING_PICK_TTL_MS, notConfigured, type MetaAppStatus, type PendingPageView, type PostingTarget, SOCIAL_NETWORKS, type SocialAccountRow, type SocialAccountView, type SocialNetwork } from "./contracts";
import type { SocialJob } from "./runner";
import { FACEBOOK_REEL, INSTAGRAM_REEL } from "./limits";
import { disconnectInputSchema, parseWithSchema, selectPageInputSchema, setMetaAppInputSchema, setMetaConfigInputSchema, startConnectInputSchema } from "./schemas";

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
  jobs?: {
    list(channelId: string | null): Promise<SocialJob[]>;
    get(jobId: string): Promise<SocialJob | null>;
    /** The owner's retry mark, set only while the job is failed, never sent a publishing call and has no post id (false otherwise). */
    markOwnerRetry(jobId: string, at: number): Promise<boolean>;
  };
  now: () => number;
  randomId: () => string;
};

type ConnectState = { channelId: string; redirectUri: string; expiresAt: number };
type PendingPick = { channelId: string; pages: MetaPage[]; expiresAt: number };

/** The Page a row posts through (a Facebook row is the Page itself). */
const storedPageOf = (row: SocialAccountRow): string | null => row.pageId ?? (row.network === "facebook" ? row.externalId : null);

/**
 * Per network (2026-11-23, owner TG 4779): the account Meta's live answer names for it and the problems only that network can have.
 * The token's validity, the Page and the network's own scopes are judged for every network on top of this. A new network is a new
 * entry (the Record makes it required), never a branch inside a shared check that could stop the others.
 */
const META_NETWORK_IDENTITY: Record<SocialNetwork, { liveId(live: MetaTokenInspection): string | null; problems(row: SocialAccountRow, live: MetaTokenInspection): AccountCheckProblem[] }> = {
  facebook: { liveId: (live) => live.page?.pageId ?? null, problems: () => [] },
  instagram: {
    liveId: (live) => live.instagram?.igUserId ?? null,
    problems: (row, live) => (live.instagram ? (live.instagram.igUserId === row.externalId ? [] : ["instagram_mismatch"]) : live.instagramUnreadable ? ["instagram_unreadable"] : ["instagram_unlinked"]),
  },
};

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

  async function readApp(): Promise<{ appId: string; appSecret: string; configId: string | null }> {
    const raw = await deps.appSecret.read();
    if (!raw) throw notConfigured();
    try {
      const parsed = JSON.parse(raw) as { appId?: unknown; appSecret?: unknown; configId?: unknown };
      if (typeof parsed.appId === "string" && typeof parsed.appSecret === "string") {
        return { appId: parsed.appId, appSecret: parsed.appSecret, configId: typeof parsed.configId === "string" && parsed.configId ? parsed.configId : null };
      }
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

  /**
   * AC-XP-8, per network (2026-11-23, owner TG 4779): one read of Meta's answer about the stored Page token, judged separately for
   * every connected network. The token and Page asked about are the Facebook row's (the Page itself), else another network's own
   * (Facebook disconnected). The token never leaves this module except to the gateway through the runner.
   */
  async function inspect(channelId: string): Promise<{ check: AccountCheck; rows: SocialAccountRow[]; token: string; pageId: string; live: MetaTokenInspection }> {
    const rows = await deps.store.list(channelId);
    const anchor = rows.find((r) => r.network === "facebook" && storedPageOf(r)) ?? rows.find((r) => storedPageOf(r));
    if (!anchor) throw new DomainError({ code: "not_found", message: `Channel ${channelId} has no connected Meta account.`, details: { channelId } });
    const pageId = storedPageOf(anchor)!;
    const app = await readApp();
    const token = await openToken(anchor.tokenSealed);
    const live = await deps.meta.inspectPageToken({ appId: app.appId, appSecret: app.appSecret, pageId, pageToken: token });
    const networks: NetworkAccountCheck[] = [];
    for (const network of SOCIAL_NETWORKS) {
      const row = rows.find((r) => r.network === network);
      if (!row) continue;
      const identity = META_NETWORK_IDENTITY[network];
      const missingScopes = live.valid ? META_NETWORK_SCOPES[network].filter((s) => !live.scopes.includes(s)) : [];
      const problems: AccountCheckProblem[] = [];
      if (!live.valid) problems.push("token_invalid");
      else {
        if (missingScopes.length) problems.push("scope_missing");
        // Every Meta network posts with this one Page token: its row must name the Page asked about, and Meta must answer that Page.
        // `debug_token`'s `profile_id` (the token's own Page), when Meta gives one, must be that Page too (review 23.11).
        if (storedPageOf(row) !== pageId || live.page?.pageId !== pageId || (live.profileId !== undefined && live.profileId !== pageId)) problems.push("page_mismatch");
        problems.push(...identity.problems(row, live));
      }
      networks.push({ network, ok: problems.length === 0, problems, missingScopes, stored: row.externalId, live: live.valid ? identity.liveId(live) : null });
    }
    const fb = rows.find((r) => r.network === "facebook") ?? null;
    const ig = rows.find((r) => r.network === "instagram") ?? null;
    const check: AccountCheck = {
      channelId,
      checkedAt: deps.now(),
      ok: networks.every((n) => n.ok),
      problems: [...new Set(networks.flatMap((n) => n.problems))],
      missingScopes: [...new Set(networks.flatMap((n) => n.missingScopes))],
      scopes: live.scopes,
      tokenExpiresAt: live.expiresAt,
      networks,
      facebook: fb ? { stored: fb.externalId, live: live.page?.pageId ?? null, name: live.page?.pageName ?? null } : null,
      instagram: ig || live.instagram ? { stored: ig?.externalId ?? null, live: live.instagram?.igUserId ?? null, username: live.instagram?.username ?? null } : null,
    };
    return { check, rows, token, pageId, live };
  }

  /** AC-XP-16, per network: the rolling 24 h count -- Instagram as Meta counts it (null: unknown), a Facebook Page by this computer's own Reels. */
  const NETWORK_QUOTA: Record<SocialNetwork, (channelId: string) => Promise<{ used: number | null; limit: number }>> = {
    facebook: async (channelId) => {
      const since = deps.now() - 24 * 60 * 60_000;
      const jobs = deps.jobs ? await deps.jobs.list(channelId) : [];
      return { used: jobs.filter((j) => j.network === "facebook" && j.status === "published" && j.updatedAt >= since).length, limit: FACEBOOK_REEL.postsPer24h };
    },
    instagram: async (channelId) => {
      const ig = (await deps.store.list(channelId)).find((r) => r.network === "instagram");
      // The Instagram row's own sealed token (the Page's): Facebook's row is never needed to count Instagram.
      const used = ig && deps.meta.igPublishingUsage ? await openToken(ig.tokenSealed).then((token) => deps.meta.igPublishingUsage!({ igUserId: ig.externalId, token })).catch(() => null) : null;
      return { used, limit: INSTAGRAM_REEL.postsPer24h };
    },
  };

  const api = {
    async getMetaApp(): Promise<MetaAppStatus> {
      const info = await deps.appSecret.info();
      return { configured: Boolean(info), appId: info?.hints.appId ?? null, configId: info?.hints.configId ?? null };
    },

    /** Saved as typed; Meta checks it on the first connect (a wrong secret fails the code exchange with Meta's own message). */
    async setMetaApp(raw: unknown): Promise<MetaAppStatus> {
      const input = parseWithSchema(setMetaAppInputSchema, raw, "Meta app");
      // A configuration saved before stays (it belongs to the same app until the owner changes it).
      const previous = await readApp().catch(() => null);
      const configId = previous && previous.appId === input.appId ? previous.configId : null;
      await deps.appSecret.write(JSON.stringify({ appId: input.appId, appSecret: input.appSecret.toLowerCase(), ...(configId ? { configId } : {}) }), { hints: { appId: input.appId, ...(configId ? { configId } : {}) } });
      return { configured: true, appId: input.appId, configId };
    },

    /**
     * 2026-11-15: the Facebook Login for Business configuration (`config_id`) the connect dialog uses -- Instagram refuses resumable
     * Reel uploads from apps without it. Stored with the app (the secret is kept as it is); null goes back to the plain scopes.
     */
    async setMetaConfig(raw: unknown): Promise<MetaAppStatus> {
      const input = parseWithSchema(setMetaConfigInputSchema, raw, "Meta configuration");
      const app = await readApp();
      const configId = input.configId;
      await deps.appSecret.write(JSON.stringify({ appId: app.appId, appSecret: app.appSecret, ...(configId ? { configId } : {}) }), { hints: { appId: app.appId, ...(configId ? { configId } : {}) } });
      return { configured: true, appId: app.appId, configId };
    },

    async clearMetaApp(): Promise<MetaAppStatus> {
      await deps.appSecret.clear();
      return { configured: false, appId: null, configId: null };
    },

    async startConnect(raw: unknown, redirectUri: string): Promise<{ authorizeUrl: string }> {
      const input = parseWithSchema(startConnectInputSchema, raw, "connect request");
      await requireChannel(input.channelId);
      const app = await readApp();
      sweep();
      const state = deps.randomId();
      states.set(state, { channelId: input.channelId, redirectUri, expiresAt: deps.now() + CONNECT_STATE_TTL_MS });
      return { authorizeUrl: deps.meta.authorizeUrl({ appId: app.appId, redirectUri, state, configId: app.configId }) };
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
      // 2026-11-15 (WWE): `/me/accounts` returned the Page without its Instagram although the Page token reaches it (the same read
      // the check makes). Without a linked account in the list, the Page's own answer decides; a failed read keeps the list's answer.
      let instagram = page.instagram;
      if (!instagram) {
        const app = await readApp().catch(() => null);
        const live = app ? await deps.meta.inspectPageToken({ appId: app.appId, appSecret: app.appSecret, pageId: page.pageId, pageToken: page.pageToken }).catch(() => null) : null;
        if (live?.valid && live.page?.pageId === page.pageId && live.instagram) instagram = { igUserId: live.instagram.igUserId, username: live.instagram.username, pictureUrl: null };
      }
      await deps.store.upsert({ ...base, network: "facebook", externalId: page.pageId, displayName: page.pageName, username: null });
      if (instagram) await deps.store.upsert({ ...base, network: "instagram", externalId: instagram.igUserId, displayName: instagram.username ?? page.pageName, username: instagram.username });
      else await deps.store.remove(pick.channelId, "instagram");
      return (await deps.store.list(pick.channelId)).map(view);
    },

    /**
     * AC-XP-8 identity read: asks Meta what the stored Page token is (valid? scopes?) and which Page / Instagram account it reaches,
     * and compares that with what this channel stored. Read-only; the token is opened here and never leaves the module.
     */
    async checkAccounts(channelId: string): Promise<AccountCheck> {
      return (await inspect(channelId)).check;
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
     * The runner's port (AC-XP-8, per network since 2026-11-23, owner TG 4779): the Page token and THIS network's account, only after
     * Meta's live answer passes for this network (its scopes, the same Page, its own account). Another network's problem never
     * refuses it; a problem of the shared Page token (`token_invalid`, `page_mismatch`) refuses every network. Refusals are
     * `social_account_mismatch` with `details.problems` (`not_connected` when the channel stored no account for the network).
     */
    async postingTarget(channelId: string, network: SocialNetwork): Promise<PostingTarget> {
      const { check, rows, token, pageId, live } = await inspect(channelId);
      const own = check.networks.find((n) => n.network === network);
      const row = rows.find((r) => r.network === network);
      if (!own || !row) throw new DomainError({ code: "social_account_mismatch", message: `No ${network} account is connected for this channel (not_connected).`, details: { channelId, network, problems: ["not_connected"] } });
      // Instagram unreadable for no definite reason (no answer, a 5xx, a rate limit) is not a verdict: refused as unavailable, so the
      // runner asks again on its next pass and never fails a job (or one already publishing) for a blip. Still never posted on it.
      if (!own.ok && live.instagramReadTransient && own.problems.length === 1 && own.problems[0] === "instagram_unreadable") {
        throw new DomainError({ code: "social_unavailable", message: `The ${network} account could not be read just now (instagram_unreadable); asked again later.`, details: { channelId, network, problems: own.problems } });
      }
      if (!own.ok) throw new DomainError({ code: "social_account_mismatch", message: `The connected ${network} account did not pass the check (${own.problems.join(", ")}).`, details: { channelId, network, problems: own.problems, missingScopes: own.missingScopes } });
      return { network, token, pageId, accountId: row.externalId };
    },

    /**
     * AC-XP-16: whether one more post fits the network's rolling 24 h limit -- Instagram as Meta counts it (`content_publishing_limit`),
     * a Facebook Page by this computer's own published Reels. Unknown counts as fitting only for Facebook (our own count is exact).
     */
    async quota(channelId: string): Promise<{ instagram: { used: number | null; limit: number }; facebook: { used: number; limit: number } }> {
      const [instagram, facebook] = await Promise.all([NETWORK_QUOTA.instagram(channelId), NETWORK_QUOTA.facebook(channelId)]);
      return { instagram, facebook: { used: facebook.used ?? 0, limit: facebook.limit } };
    },

    /** The runner's quota gate for ONE network: counts only that network (unknown = wait). */
    async quotaAllows(channelId: string, network: SocialNetwork): Promise<boolean> {
      const q = await NETWORK_QUOTA[network](channelId);
      return q.used !== null && q.used < q.limit;
    },

    async listJobs(channelId: string | null): Promise<SocialJob[]> {
      return deps.jobs ? deps.jobs.list(channelId) : [];
    },

    /**
     * The owner's retry (Web UI only; no MCP or agent path) of a failed job that never sent its publishing call. Owner TG 4780: the
     * retry is recorded on the job (`ownerRetryAt`) instead of forgetting it, and the runner then posts it however late -- the 12 h
     * window binds only the automatic start -- but never before its planned time; the slot's approval, the network's identity read
     * and its quota still apply. A mark the runner cannot act on is cleared with its own code (slot no longer approved, network
     * blocked, refused again) or after 48 h; the owner may then retry again.
     */
    async retryJob(raw: unknown): Promise<{ retried: boolean }> {
      const jobId = (raw as { jobId?: unknown } | null)?.jobId;
      if (typeof jobId !== "string" || !jobId) throw new DomainError({ code: "validation_failed", message: "jobId is required" });
      const job = deps.jobs ? await deps.jobs.get(jobId) : null;
      if (!job) throw new DomainError({ code: "not_found", message: "No such job on this computer." });
      const refused = () => new DomainError({ code: "validation_failed", message: "Only a failed job that never sent its publishing call can be retried." });
      // Review 14.11: a job whose publishing call was sent may be live even without a post id -- never retried.
      if (job.status !== "failed" || job.remotePostId || job.publishAttempted) throw refused();
      // Review 23.11: the mark itself is conditional on the same facts, so a runner pass that took the job over between the read
      // above and this write is never marked for another post.
      if (!(await deps.jobs!.markOwnerRetry(jobId, deps.now()))) throw refused();
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
