import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { jsonRequest } from "./http";
import { asNumber, asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// BL-132 (docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.1) -- the single funnel for the Hugging Face
// Hub HTTP API: the metadata a model pull is checked against BEFORE any pod is created (no cost). Two reads,
// the same ones `huggingface_hub` makes: `model_info` at a revision (resolves it to a commit, tells gated /
// private) and `paths-info` at that commit (the file's size and, for an LFS file, its SHA-256 = `lfs.oid`).
// Public repos only in this phase: no token is ever sent (gated repos with the owner's token are BL-134).
// The downloads themselves happen on the pull pod (`hf download`), never through this process.
// ---------------------------------------------------------------------------

export const HUGGINGFACE_BASE_URL = "https://huggingface.co";
const REQUEST_TIMEOUT_MS = 30_000;

export type HuggingFaceFileInfo = {
  repoId: string;
  /** The revision asked for (default `main`). */
  revision: string;
  /** The commit that revision resolved to -- the pull downloads exactly this commit. */
  commitSha: string;
  path: string;
  bytes: number;
  /** The Hub's SHA-256 of an LFS file; `null` for a file stored in git (no declared hash). */
  sha256: string | null;
};

type Fetch = typeof fetch;

export function createHuggingFaceClient(args: { fetchImpl?: Fetch; authorize?: Authorize; baseUrl?: string } = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? HUGGINGFACE_BASE_URL).replace(/\/$/, "");

  async function request(method: string, path: string, context: Record<string, unknown>, form?: string): Promise<unknown> {
    await authorize("huggingface_api");
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers: { accept: "application/json", ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
      body: form,
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({
          code: "huggingface_unavailable",
          message: stage === "request" ? `Hugging Face Hub request failed: ${detail}` : `Hugging Face Hub response could not be read: ${detail}`,
          details: { ...context, ...(status !== undefined ? { status } : {}) },
        }),
    });
    const detail = asString(asRecord(response.body).error);
    if (response.status === 401 || response.status === 403) {
      // Unauthenticated, the Hub answers 401 for a repository that does not exist too (independent review): it cannot be
      // told apart from a private one, so the message names both.
      throw new DomainError({ code: "media_model_gated", message: `Hugging Face refused access (HTTP ${response.status}): the repository is gated or private, or does not exist (check the repo id); only public repositories can be pulled.`, details: { ...context, status: response.status, detail } });
    }
    if (response.status === 404) {
      throw new DomainError({ code: "media_model_not_found", message: `Hugging Face has no such repository or revision (HTTP 404).`, details: { ...context, status: 404, detail } });
    }
    if (!response.ok) {
      throw new DomainError({ code: "huggingface_unavailable", message: `Hugging Face Hub answered HTTP ${response.status}.`, details: { ...context, status: response.status, detail } });
    }
    return response.body;
  }

  const repoPath = (repoId: string) => repoId.split("/").map(encodeURIComponent).join("/");

  return {
    async getFileInfo(input: { repoId: string; file: string; revision?: string }): Promise<HuggingFaceFileInfo> {
      const revision = input.revision ?? "main";
      const context = { repoId: input.repoId, file: input.file, revision };
      const info = asRecord(await request("GET", `/api/models/${repoPath(input.repoId)}/revision/${encodeURIComponent(revision)}`, context));
      // `gated` is false, "auto" or "manual"; anything but false needs an accepted licence + token.
      if ((info.gated !== undefined && info.gated !== false) || info.private === true) {
        throw new DomainError({ code: "media_model_gated", message: "The repository is gated or private; only public repositories can be pulled (gated repos: BL-134).", details: { ...context, gated: info.gated ?? null, private: info.private ?? null } });
      }
      const commitSha = asString(info.sha);
      if (!commitSha) throw new DomainError({ code: "huggingface_unavailable", message: "Hugging Face did not report the revision's commit.", details: context });
      const form = new URLSearchParams([["paths", input.file], ["expand", "false"]]).toString();
      const entries = await request("POST", `/api/models/${repoPath(input.repoId)}/paths-info/${encodeURIComponent(commitSha)}`, context, form);
      const entry = (Array.isArray(entries) ? entries : []).map(asRecord).find((e) => asString(e.path) === input.file && asString(e.type) === "file");
      if (!entry) throw new DomainError({ code: "media_model_not_found", message: `${input.file} is not a file in ${input.repoId}@${revision}.`, details: context });
      const lfs = entry.lfs === undefined || entry.lfs === null ? null : asRecord(entry.lfs);
      const sha256 = lfs ? asString(lfs.oid) : null;
      return {
        repoId: input.repoId,
        revision,
        commitSha,
        path: input.file,
        bytes: asNumber(lfs?.size) ?? asNumber(entry.size) ?? 0,
        sha256: sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null,
      };
    },
  };
}

export type HuggingFaceClient = ReturnType<typeof createHuggingFaceClient>;
