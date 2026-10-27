import { z } from "zod";
import type { DeviceSecretSlot, DeviceSecretState } from "@/lib/device-secrets";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { parseWithSchema } from "./schemas";

/**
 * BL-230 (ADR 0043 amendment 1, docs/roadmap/plans/PRIVATE_RUNTIME_REPOS_PLAN.md): this computer's GitHub read token, kept in the
 * shared device-secret store (slot `github`), the same way as the Hugging Face token (`hf-token.ts`). Typed and checked in
 * Settings → Cloud APIs only; read by the runtime creation check (a private repository) and by the runtime build pod's env. No
 * view returns the token: only whether one is stored, the GitHub login it belongs to, its expiry and the check times.
 */

export type GithubTokenView = {
  /** `set`: stored and readable here. */
  state: DeviceSecretState;
  /** The GitHub login the token belongs to (from `GET /user` when it was saved). */
  login: string | null;
  /** `ok`, or `invalid` when the last check was refused. */
  status: string | null;
  /** The token's expiry as GitHub reported it when it was saved (null: none reported). */
  expiresAt: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
};

/**
 * A token as GitHub issues them -- fine-grained (`github_pat_` + letters, digits and `_`) or classic (`ghp_` + letters and digits);
 * anything else is refused before any call.
 */
export const GITHUB_TOKEN_PATTERN = /^(?:github_pat_[A-Za-z0-9_]{60,251}|ghp_[A-Za-z0-9]{36,251})$/;

export const setGithubTokenInputSchema = z
  .object({ token: z.string().trim().regex(GITHUB_TOKEN_PATTERN, "a GitHub token looks like github_pat_… (fine-grained) or ghp_… (classic)") })
  .strict();

export type GithubTokenDeps = {
  slot: DeviceSecretSlot;
  github: { whoami(token: string): Promise<{ login: string; expiresAt: string | null }> };
  now?: () => number;
};

export function createGithubTokenServices(deps: GithubTokenDeps) {
  const now = deps.now ?? (() => Date.now());

  async function view(): Promise<GithubTokenView> {
    const [state, info] = await Promise.all([deps.slot.state(), deps.slot.info()]);
    return {
      state,
      login: info?.hints.login ?? null,
      status: info?.status ?? null,
      expiresAt: info?.hints.expiresAt ?? null,
      verifiedAt: info?.verifiedAt ? new Date(info.verifiedAt).toISOString() : null,
      updatedAt: info ? new Date(info.updatedAt).toISOString() : null,
    };
  }

  return {
    getGithubToken: view,

    /** Checks the token with GitHub (`GET /user`) and only then stores it; a refused token stores nothing (`github_token_invalid`). */
    async setGithubToken(input: unknown): Promise<GithubTokenView> {
      const { token } = parseWithSchema(setGithubTokenInputSchema, input, "GitHub token");
      const { login, expiresAt } = await deps.github.whoami(token);
      await deps.slot.write(token, { hints: { login, expiresAt }, status: "ok", verifiedAt: now() });
      return view();
    },

    /** One `GET /user` with the stored token; the result is recorded only on the token that was checked (compare-and-set). */
    async testGithubToken(): Promise<GithubTokenView> {
      const read = await deps.slot.readWithVersion();
      if (!read) throw new DomainError({ code: "github_token_missing", message: "No GitHub token is stored on this computer." });
      try {
        await deps.github.whoami(read.value);
        await deps.slot.setStatus(read.version, { status: "ok", verifiedAt: now() });
      } catch (error) {
        if (isDomainError(error) && error.code === "github_token_invalid") await deps.slot.setStatus(read.version, { status: "invalid", verifiedAt: now() });
        throw error;
      }
      return view();
    },

    async clearGithubToken(): Promise<GithubTokenView> {
      await deps.slot.clear();
      return view();
    },

    /** For the runtime creation check and the build pod only: the token in clear, or null. Never returned by a route or tool. */
    readGithubToken: (): Promise<string | null> => deps.slot.read(),
  };
}

export type GithubTokenServices = ReturnType<typeof createGithubTokenServices>;
