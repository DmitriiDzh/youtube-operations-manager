import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { jsonRequest } from "./http";
import { asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// BL-200 (FO-REQ-0029, ADR 0043) -- the media gateway's GitHub child: the two public reads a pod runtime profile needs. It lists
// ComfyUI's releases for the Operator, and it resolves a tag or branch to the exact commit a profile stores (a tag can move; a
// commit cannot). Downloads (git clone) happen on the build pod, never in this process.
// BL-230 (ADR 0043 amendment 1): a call MAY carry the owner's GitHub read token (passed per call, never stored here) -- for a
// private repository and for the token's own check (`whoami`). Without one no Authorization header is sent. With one, it goes to
// this base URL only (`redirect: "error"`: a redirect never carries it elsewhere), and it never appears in an error or its details.
// ---------------------------------------------------------------------------

export const GITHUB_API_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/;

export type GithubRelease = { tag: string; name: string | null; publishedAt: string | null; prerelease: boolean };
/** BL-230: per-call options; `token` = the owner's read token, sent as a Bearer header. */
export type GithubCallOptions = { token?: string | null };

/** GitHub's `github-authentication-token-expiration` header ("2026-11-26 00:00:00 UTC") as ISO time, or null. */
export function parseGithubTokenExpiration(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const zone = !match[3] || match[3] === "UTC" || match[3] === "Z" ? "Z" : match[3].length === 5 ? `${match[3].slice(0, 3)}:${match[3].slice(3)}` : match[3];
  const ms = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

type Fetch = typeof fetch;

export function createGithubClient(args: { fetchImpl?: Fetch; authorize?: Authorize; baseUrl?: string } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/$/, "");

  function repoPath(owner: string, repo: string): string {
    if (!OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) {
      throw new DomainError({ code: "validation_failed", message: `${owner}/${repo} is not a GitHub owner/repository name.`, details: { owner, repo } });
    }
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async function send(path: string, context: Record<string, unknown>, token: string | null | undefined) {
    await authorize("github_api");
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "yt-operations-manager",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(token ? { redirect: "error" as const } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({
          code: "github_unavailable",
          message: stage === "request" ? `GitHub request failed: ${detail}` : `GitHub response could not be read: ${detail}`,
          details: { ...context, ...(status !== undefined ? { status } : {}) },
        }),
    });
    if (token && response.status === 401) {
      throw new DomainError({ code: "github_token_invalid", message: "GitHub did not accept the stored token (HTTP 401): it may have expired or been revoked. Enter a new read token in Settings → Cloud APIs.", details: { ...context, status: 401 } });
    }
    return response;
  }

  async function get(path: string, context: Record<string, unknown>, token?: string | null): Promise<unknown> {
    const response = await send(path, context, token);
    // BL-230: GitHub answers 404 for a repository it does not show (missing, or private to this caller) and 422 for an unknown
    // commit, tag or branch in one it does show; `details.missing` keeps the two apart.
    if (response.status === 404 || response.status === 422) {
      const missing = response.status === 404 ? "repository" : "ref";
      throw new DomainError({ code: "not_found", message: `GitHub has no such ${missing === "repository" ? "repository (or it is private)" : "commit, tag or branch"} (HTTP ${response.status}).`, details: { ...context, status: response.status, missing } });
    }
    if (!response.ok) {
      throw new DomainError({ code: "github_unavailable", message: `GitHub answered HTTP ${response.status}${response.status === 403 ? " (rate limit?)" : ""}.`, details: { ...context, status: response.status } });
    }
    return response.body;
  }

  return {
    /** The repository's newest releases (at most 30), newest first. */
    async listReleases(owner: string, repo: string): Promise<GithubRelease[]> {
      const body = await get(`${repoPath(owner, repo)}/releases?per_page=30`, { owner, repo });
      return (Array.isArray(body) ? body : []).map(asRecord).flatMap((r) => {
        const tag = asString(r.tag_name);
        return tag ? [{ tag, name: asString(r.name) ?? null, publishedAt: asString(r.published_at) ?? null, prerelease: r.prerelease === true }] : [];
      });
    },

    /** The exact commit a tag, branch or short sha names right now. */
    async resolveCommit(owner: string, repo: string, ref: string, options: GithubCallOptions = {}): Promise<{ commit: string; date: string | null }> {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) {
        throw new DomainError({ code: "validation_failed", message: `${ref} is not a tag, branch or commit.`, details: { ref } });
      }
      const body = asRecord(await get(`${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`, { owner, repo, ref }, options.token));
      const commit = asString(body.sha);
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new DomainError({ code: "github_unavailable", message: "GitHub did not report a commit.", details: { owner, repo, ref } });
      const date = asString(asRecord(asRecord(body.commit).committer).date) ?? null;
      return { commit, date };
    },

    /**
     * BL-230: the token's own check -- `GET /user` with it. Its login, and its expiry from GitHub's
     * `github-authentication-token-expiration` header (null for a token without one). 401 = `github_token_invalid`.
     */
    async whoami(token: string): Promise<{ login: string; expiresAt: string | null }> {
      const response = await send("/user", {}, token);
      if (!response.ok) {
        throw new DomainError({ code: "github_unavailable", message: `GitHub answered HTTP ${response.status} to the token check${response.status === 403 ? " (rate limit?)" : ""}.`, details: { status: response.status } });
      }
      const login = asString(asRecord(response.body).login);
      if (!login) throw new DomainError({ code: "github_unavailable", message: "GitHub did not name the token's user." });
      return { login, expiresAt: parseGithubTokenExpiration(response.header?.("github-authentication-token-expiration") ?? null) };
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
