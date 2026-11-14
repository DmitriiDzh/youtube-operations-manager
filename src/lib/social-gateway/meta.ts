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
/** Where Meta takes a local file's bytes (resumable uploads, Facebook Login for Business). */
export const META_RUPLOAD_BASE = "https://rupload.facebook.com";
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
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

/** What a stored Page token can do right now (Meta's own answer): validity, granted scopes and the accounts it reaches. */
export type MetaTokenInspection = {
  valid: boolean;
  scopes: string[];
  /** Unix ms; null = does not expire on a schedule (a Page token from a long-lived user token). */
  expiresAt: number | null;
  page: { pageId: string; pageName: string } | null;
  instagram: { igUserId: string; username: string | null } | null;
};

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

export type UploadBody = { stream: () => ReadableStream<Uint8Array>; sizeBytes: number };

/**
 * `postingAllowed`: the switch «Публикация в соцсети» of this computer (the cross-posting module's setting), asked immediately
 * before EVERY mutating call -- like Live writes for YouTube. Off (or absent) refuses with `social_posting_disabled` before any
 * network request.
 */
export function createMetaClient(args: { fetchImpl?: Fetch; postingAllowed?: () => Promise<boolean> } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const postingAllowed = args.postingAllowed ?? (async () => false);

  async function assertPostingAllowed(call: string) {
    if (!(await postingAllowed())) throw new DomainError({ code: "social_posting_disabled", message: "Posting to social networks is switched off on this computer (Settings → Channels → Social networks).", details: { network: "meta", call } });
  }

  async function readBody(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /** A form POST to the Graph API; the token travels in the body, never in the URL. */
  async function postForm(path: string, params: Record<string, string>, call: string): Promise<Record<string, unknown>> {
    await assertPostingAllowed(call);
    let res: Response;
    try {
      res = await fetchImpl(`${META_GRAPH_BASE}/${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(), redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new DomainError({ code: "social_unavailable", message: `Meta could not be reached (${call}): ${error instanceof Error ? error.message : String(error)}`, details: { network: "meta", call } });
    }
    const body = await readBody(res);
    if (!res.ok) throw metaError(res.status, body, call);
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  }

  /** The file's bytes to rupload (one request from offset 0); the token in the Authorization header. */
  async function uploadTo(url: string, token: string, body: UploadBody, call: string): Promise<Record<string, unknown>> {
    await assertPostingAllowed(call);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `OAuth ${token}`, offset: "0", file_size: String(body.sizeBytes), "content-type": "application/octet-stream" },
        body: body.stream(),
        // Node's fetch needs this for a streamed request body.
        ...({ duplex: "half" } as Record<string, unknown>),
        redirect: "error",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      } as RequestInit);
    } catch (error) {
      throw new DomainError({ code: "social_unavailable", message: `Meta upload failed (${call}): ${error instanceof Error ? error.message : String(error)}`, details: { network: "meta", call } });
    }
    const parsed = await readBody(res);
    if (!res.ok) throw metaError(res.status, parsed, call);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  const str = (v: unknown) => (typeof v === "string" && v ? v : null);

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
    // ----- Instagram Reels (resumable, local file) — developers.facebook.com/docs/instagram-platform/content-publishing -----

    /** Creates the Reel container (caption, AI label) and returns its id; the bytes go to `igUploadReel` next. */
    async igCreateReelContainer(input: { igUserId: string; token: string; caption: string; shareToFeed: boolean; isAiGenerated: boolean }): Promise<{ containerId: string }> {
      const body = await postForm(`${encodeURIComponent(input.igUserId)}/media`, { media_type: "REELS", upload_type: "resumable", caption: input.caption, share_to_feed: String(input.shareToFeed), is_ai_generated: String(input.isAiGenerated), access_token: input.token }, "ig.media");
      const containerId = str(body.id);
      if (!containerId) throw new DomainError({ code: "social_request_rejected", message: "Meta returned no container id.", details: { network: "meta", call: "ig.media" } });
      return { containerId };
    },

    async igUploadReel(input: { containerId: string; token: string; body: UploadBody }): Promise<void> {
      await uploadTo(`${META_RUPLOAD_BASE}/ig-api-upload/${META_GRAPH_VERSION}/${encodeURIComponent(input.containerId)}`, input.token, input.body, "ig.upload");
    },

    /** IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED (read-only). */
    async igContainerStatus(input: { containerId: string; token: string }): Promise<string> {
      const u = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(input.containerId)}`);
      u.searchParams.set("fields", "status_code");
      u.searchParams.set("access_token", input.token);
      return str((await getJson(u, "ig.container_status")).status_code) ?? "UNKNOWN";
    },

    async igPublish(input: { igUserId: string; containerId: string; token: string }): Promise<{ mediaId: string }> {
      const body = await postForm(`${encodeURIComponent(input.igUserId)}/media_publish`, { creation_id: input.containerId, access_token: input.token }, "ig.media_publish");
      const mediaId = str(body.id);
      if (!mediaId) throw new DomainError({ code: "social_request_rejected", message: "Meta returned no media id.", details: { network: "meta", call: "ig.media_publish" } });
      return { mediaId };
    },

    async igPermalink(input: { mediaId: string; token: string }): Promise<string | null> {
      const u = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(input.mediaId)}`);
      u.searchParams.set("fields", "permalink");
      u.searchParams.set("access_token", input.token);
      return str((await getJson(u, "ig.permalink")).permalink);
    },

    /** The account's API posts in the last 24 h (`content_publishing_limit`, read-only); null when Meta does not say. */
    async igPublishingUsage(input: { igUserId: string; token: string }): Promise<number | null> {
      const u = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(input.igUserId)}/content_publishing_limit`);
      u.searchParams.set("fields", "quota_usage");
      u.searchParams.set("access_token", input.token);
      const data = (await getJson(u, "ig.publishing_limit")).data;
      const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      return typeof first?.quota_usage === "number" ? first.quota_usage : null;
    },

    // ----- Facebook Page Reels — developers.facebook.com/docs/video-api/guides/reels-publishing -----

    async fbReelStart(input: { pageId: string; token: string }): Promise<{ videoId: string; uploadUrl: string }> {
      const body = await postForm(`${encodeURIComponent(input.pageId)}/video_reels`, { upload_phase: "start", access_token: input.token }, "fb.reels_start");
      const videoId = str(body.video_id);
      const uploadUrl = str(body.upload_url);
      if (!videoId || !uploadUrl || !uploadUrl.startsWith(`${META_RUPLOAD_BASE}/`)) throw new DomainError({ code: "social_request_rejected", message: "Meta returned no usable upload address.", details: { network: "meta", call: "fb.reels_start" } });
      return { videoId, uploadUrl };
    },

    async fbUploadReel(input: { uploadUrl: string; token: string; body: UploadBody }): Promise<void> {
      if (!input.uploadUrl.startsWith(`${META_RUPLOAD_BASE}/`)) throw new DomainError({ code: "social_request_rejected", message: "Refusing an upload address outside rupload.facebook.com.", details: { network: "meta" } });
      await uploadTo(input.uploadUrl, input.token, input.body, "fb.upload");
    },

    /** Publishes now (YTM keeps the schedule itself; Facebook's own scheduling is never used — ADR 0068 amendment 1 §2). */
    async fbReelFinish(input: { pageId: string; token: string; videoId: string; title: string | null; description: string; isAiGenerated: boolean }): Promise<void> {
      const params: Record<string, string> = { upload_phase: "finish", video_id: input.videoId, video_state: "PUBLISHED", description: input.description, is_ai_generated: String(input.isAiGenerated), access_token: input.token };
      if (input.title) params.title = input.title;
      const body = await postForm(`${encodeURIComponent(input.pageId)}/video_reels`, params, "fb.reels_finish");
      if (body.success === false) throw new DomainError({ code: "social_request_rejected", message: "Meta did not accept the Reel.", details: { network: "meta", call: "fb.reels_finish" } });
    },

    /** The Reel's processing / publishing state and its address (read-only). */
    async fbVideoStatus(input: { videoId: string; token: string }): Promise<{ videoStatus: string | null; publishStatus: string | null; permalink: string | null }> {
      const u = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(input.videoId)}`);
      u.searchParams.set("fields", "status,permalink_url");
      u.searchParams.set("access_token", input.token);
      const body = await getJson(u, "fb.video_status");
      const status = (body.status ?? {}) as Record<string, unknown>;
      const publishing = (status.publishing_phase ?? {}) as Record<string, unknown>;
      const link = str(body.permalink_url);
      return { videoStatus: str(status.video_status), publishStatus: str(publishing.publish_status) ?? str(publishing.status), permalink: link ? (link.startsWith("http") ? link : `https://www.facebook.com${link}`) : null };
    },

    /**
     * BL-252 stage 2 (AC-XP-8): the identity read before anything is posted -- `debug_token` (with the app token, so the Page token
     * is never sent as the caller) gives validity and scopes; `/{page-id}` with the Page token gives the Page and its linked
     * Instagram account. Read-only; tokens travel in the query string as Meta documents, and never appear in an error.
     */
    async inspectPageToken(input: { appId: string; appSecret: string; pageId: string; pageToken: string }): Promise<MetaTokenInspection> {
      const d = new URL(`${META_GRAPH_BASE}/debug_token`);
      d.searchParams.set("input_token", input.pageToken);
      d.searchParams.set("access_token", `${input.appId}|${input.appSecret}`);
      const debug = ((await getJson(d, "debug_token")).data ?? {}) as Record<string, unknown>;
      const valid = debug.is_valid === true;
      const scopes = Array.isArray(debug.scopes) ? debug.scopes.filter((s): s is string => typeof s === "string") : [];
      const exp = typeof debug.expires_at === "number" && debug.expires_at > 0 ? debug.expires_at * 1000 : null;
      if (!valid) return { valid: false, scopes, expiresAt: exp, page: null, instagram: null };
      const u = new URL(`${META_GRAPH_BASE}/${encodeURIComponent(input.pageId)}`);
      u.searchParams.set("fields", "id,name,instagram_business_account{id,username}");
      u.searchParams.set("access_token", input.pageToken);
      const p = await getJson(u, "page");
      const ig = (p.instagram_business_account ?? null) as Record<string, unknown> | null;
      return {
        valid: true,
        scopes,
        expiresAt: exp,
        page: typeof p.id === "string" ? { pageId: p.id, pageName: typeof p.name === "string" ? p.name : p.id } : null,
        instagram: ig && typeof ig.id === "string" ? { igUserId: ig.id, username: typeof ig.username === "string" ? ig.username : null } : null,
      };
    },

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
