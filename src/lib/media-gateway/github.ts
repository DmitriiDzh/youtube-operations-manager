import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { jsonRequest } from "./http";
import { asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// BL-200 (FO-REQ-0029, ADR 0043) -- the media gateway's GitHub child: the two public reads a pod runtime profile needs. It lists
// ComfyUI's releases for the Operator, and it resolves a tag or branch to the exact commit a profile stores (a tag can move; a
// commit cannot). Unauthenticated: no token is ever sent. Downloads (git clone) happen on the build pod, never in this process.
// ---------------------------------------------------------------------------

export const GITHUB_API_BASE_URL = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const OWNER_REPO = /^[A-Za-z0-9_.-]{1,100}$/;

export type GithubRelease = { tag: string; name: string | null; publishedAt: string | null; prerelease: boolean };

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

  async function get(path: string, context: Record<string, unknown>): Promise<unknown> {
    await authorize("github_api");
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method: "GET",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "yt-operations-manager" },
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({
          code: "github_unavailable",
          message: stage === "request" ? `GitHub request failed: ${detail}` : `GitHub response could not be read: ${detail}`,
          details: { ...context, ...(status !== undefined ? { status } : {}) },
        }),
    });
    if (response.status === 404 || response.status === 422) {
      throw new DomainError({ code: "not_found", message: `GitHub has no such repository or ref (HTTP ${response.status}).`, details: { ...context, status: response.status } });
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
    async resolveCommit(owner: string, repo: string, ref: string): Promise<{ commit: string; date: string | null }> {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) {
        throw new DomainError({ code: "validation_failed", message: `${ref} is not a tag, branch or commit.`, details: { ref } });
      }
      const body = asRecord(await get(`${repoPath(owner, repo)}/commits/${encodeURIComponent(ref)}`, { owner, repo, ref }));
      const commit = asString(body.sha);
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new DomainError({ code: "github_unavailable", message: "GitHub did not report a commit.", details: { owner, repo, ref } });
      const date = asString(asRecord(asRecord(body.commit).committer).date) ?? null;
      return { commit, date };
    },
  };
}

export type GithubClient = ReturnType<typeof createGithubClient>;
