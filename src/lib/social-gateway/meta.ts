import { DomainError } from "@/lib/shared-domain";

// ---------------------------------------------------------------------------
// BL-252 (docs/roadmap/plans/CROSS_POSTING_PLAN.md, ADR 0068): the Meta child of the social gateway -- the ONLY code that reaches
// graph.facebook.com / www.facebook.com for the cross-posting module. Stage 1 is read-only: the Facebook Login for Business
// consent URL, the code-for-token exchange (and the long-lived exchange), and the Pages the user manages with their linked
// Instagram professional accounts. Publishing (stage 2) comes here too, behind the "Публикация в соцсети" switch.
// Tokens and the app secret are passed in per call and never logged; errors carry Meta's message, never a token.
// ---------------------------------------------------------------------------

/** UNVERIFIED until the first connect: the Graph API version used. */
export const META_GRAPH_VERSION = "v23.0";
export const META_GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_DIALOG_BASE = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
/** What stage 1-2 asks for: the Pages and their Instagram accounts, and publishing to both. */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
] as const;

const TIMEOUT_MS = 20_000;

export type MetaPage = {
  pageId: string;
  pageName: string;
  /** The Page token (long-lived when it came from a long-lived user token). Secret. */
  pageToken: string;
  instagram: { igUserId: string; username: string | null; pictureUrl: string | null } | null;
};

type Fetch = typeof fetch;

function metaError(status: number, body: unknown, call: string): DomainError {
  const err = (body && typeof body === "object" && "error" in body ? (body as { error?: Record<string, unknown> }).error : null) ?? {};
  const message = typeof err.message === "string" ? err.message.slice(0, 300) : `HTTP ${status}`;
  const code = status === 401 || err.code === 190 ? "social_token_invalid" : status === 429 || err.code === 4 || err.code === 32 ? "social_rate_limited" : "social_request_rejected";
  return new DomainError({ code, message: `Meta refused ${call}: ${message}`, details: { network: "meta", call, status, metaCode: err.code ?? null } });
}

export function createMetaClient(args: { fetchImpl?: Fetch } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;

  async function getJson(url: URL, call: string): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new DomainError({ code: "social_unavailable", message: `Meta could not be reached (${call}): ${error instanceof Error ? error.message : String(error)}`, details: { network: "meta", call } });
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) throw metaError(res.status, body, call);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  }

  return {
    /** The consent dialog the owner's browser opens (Facebook Login for Business). */
    authorizeUrl(input: { appId: string; redirectUri: string; state: string }): string {
      const u = new URL(META_DIALOG_BASE);
      u.searchParams.set("client_id", input.appId);
      u.searchParams.set("redirect_uri", input.redirectUri);
      u.searchParams.set("state", input.state);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", META_SCOPES.join(","));
      return u.toString();
    },

    /** The code from the redirect → a short-lived user token → a long-lived (~60 days) user token. */
    async exchangeCode(input: { appId: string; appSecret: string; redirectUri: string; code: string }): Promise<{ userToken: string; expiresAt: number | null }> {
      const a = new URL(`${META_GRAPH_BASE}/oauth/access_token`);
      a.searchParams.set("client_id", input.appId);
      a.searchParams.set("client_secret", input.appSecret);
      a.searchParams.set("redirect_uri", input.redirectUri);
      a.searchParams.set("code", input.code);
      const short = await getJson(a, "oauth.access_token");
      const shortToken = typeof short.access_token === "string" ? short.access_token : null;
      if (!shortToken) throw new DomainError({ code: "social_request_rejected", message: "Meta gave no access token.", details: { network: "meta" } });
      const b = new URL(`${META_GRAPH_BASE}/oauth/access_token`);
      b.searchParams.set("grant_type", "fb_exchange_token");
      b.searchParams.set("client_id", input.appId);
      b.searchParams.set("client_secret", input.appSecret);
      b.searchParams.set("fb_exchange_token", shortToken);
      const long = await getJson(b, "oauth.fb_exchange_token");
      const userToken = typeof long.access_token === "string" ? long.access_token : shortToken;
      const expiresIn = typeof long.expires_in === "number" ? long.expires_in : null;
      return { userToken, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null };
    },

    /** The Pages the user manages, each with its token and linked Instagram professional account (if any). */
    async listPages(userToken: string): Promise<MetaPage[]> {
      const u = new URL(`${META_GRAPH_BASE}/me/accounts`);
      u.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username,profile_picture_url}");
      u.searchParams.set("limit", "100");
      u.searchParams.set("access_token", userToken);
      const body = await getJson(u, "me.accounts");
      const data = Array.isArray(body.data) ? body.data : [];
      const pages: MetaPage[] = [];
      for (const raw of data) {
        const p = (raw ?? {}) as Record<string, unknown>;
        if (typeof p.id !== "string" || typeof p.access_token !== "string") continue;
        const ig = (p.instagram_business_account ?? null) as Record<string, unknown> | null;
        pages.push({
          pageId: p.id,
          pageName: typeof p.name === "string" ? p.name : p.id,
          pageToken: p.access_token,
          instagram: ig && typeof ig.id === "string" ? { igUserId: ig.id, username: typeof ig.username === "string" ? ig.username : null, pictureUrl: typeof ig.profile_picture_url === "string" ? ig.profile_picture_url : null } : null,
        });
      }
      return pages;
    },
  };
}

export type MetaClient = ReturnType<typeof createMetaClient>;
