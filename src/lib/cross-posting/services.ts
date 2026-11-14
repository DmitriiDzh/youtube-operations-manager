import type { DeviceSecretSlot } from "@/lib/device-secrets";
import type { EncryptedPayload } from "@/lib/shared-crypto";
import type { MetaClient, MetaPage } from "@/lib/social-gateway";
import { CONNECT_STATE_TTL_MS, DomainError, PENDING_PICK_TTL_MS, notConfigured, type MetaAppStatus, type PendingPageView, type SocialAccountRow, type SocialAccountView, type SocialNetwork } from "./contracts";
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

export type CrossPostingDeps = {
  store: CrossPostingStore;
  appSecret: Pick<DeviceSecretSlot, "read" | "write" | "clear" | "info">;
  sealer: { seal(plaintext: string): Promise<EncryptedPayload | null> };
  meta: MetaClient;
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

  async function requireChannel(channelId: string) {
    if (!(await deps.store.channelExists(channelId))) throw new DomainError({ code: "not_found", message: `Channel ${channelId} is not connected here.`, details: { channelId } });
  }

  return {
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

    async listAccounts(channelId: string | null): Promise<SocialAccountView[]> {
      return (await deps.store.list(channelId)).map(view);
    },

    async disconnect(raw: unknown): Promise<{ removed: number }> {
      const input = parseWithSchema(disconnectInputSchema, raw, "disconnect request");
      return { removed: await deps.store.remove(input.channelId, input.network ?? null) };
    },
  };
}

export type CrossPostingCore = ReturnType<typeof createCrossPostingServices>;
