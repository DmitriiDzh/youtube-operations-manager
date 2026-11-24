import { DomainError } from "@/lib/shared-domain";

export { DomainError };

// ---------------------------------------------------------------------------
// BL-252 (docs/roadmap/plans/CROSS_POSTING_PLAN.md, ADR 0068): the cross-posting module -- each channel connects its own accounts on
// the short-video networks; the owner approves every post (stage 2). Stage 1: the Meta app (App ID + App Secret, this computer's
// device secret `meta_app`) and connecting a channel's Facebook Page and its Instagram professional account.
// ---------------------------------------------------------------------------

export const SOCIAL_NETWORKS = ["facebook", "instagram"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** A started connect is good for 15 minutes; the Pages found after consent wait 15 minutes for the owner's pick. */
export const CONNECT_STATE_TTL_MS = 15 * 60_000;
export const PENDING_PICK_TTL_MS = 15 * 60_000;

/** What the browser sees of a connected account -- never its token. */
export type SocialAccountView = {
  channelId: string;
  network: SocialNetwork;
  externalId: string;
  displayName: string;
  username: string | null;
  pageId: string | null;
  tokenExpiresAt: number | null;
  connectedAt: number;
};

export type SocialAccountRow = SocialAccountView & { tokenSealed: string };

/** A Page offered for the owner's pick after consent (no token). */
export type PendingPageView = { pageId: string; pageName: string; instagram: { igUserId: string; username: string | null } | null };

export type MetaAppStatus = { configured: boolean; appId: string | null; configId: string | null };

/**
 * What posting needs from the stored Page token, per network (AC-XP-8; 2026-11-23, owner TG 4779: one network's problem never stops
 * another). Instagram publishes with the Page's token, so it needs the Page's scopes as well as its own.
 */
export const META_NETWORK_SCOPES: Record<SocialNetwork, readonly string[]> = {
  facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  instagram: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"],
};

/** Every scope some network needs. */
export const META_POSTING_SCOPES: readonly string[] = [...new Set(SOCIAL_NETWORKS.flatMap((n) => META_NETWORK_SCOPES[n]))];

/**
 * `token_invalid` and `page_mismatch` concern the Page token every Meta network posts with, so they fail each network; the
 * `instagram_*` problems fail only Instagram; `scope_missing` fails only the networks whose own scopes are missing.
 */
export type AccountCheckProblem = "token_invalid" | "scope_missing" | "page_mismatch" | "instagram_mismatch" | "instagram_unlinked" | "instagram_unreadable";

/** One connected network's identity read: whether a post to THIS network may go out (AC-XP-8, per network). */
export type NetworkAccountCheck = {
  network: SocialNetwork;
  ok: boolean;
  problems: AccountCheckProblem[];
  missingScopes: string[];
  /** The account id this channel stored for the network, and the one Meta's live answer names (null: none). */
  stored: string;
  live: string | null;
};

/**
 * The identity read of a channel's connected Meta accounts: Meta's live answer against what is stored (never a token).
 * `networks` has one entry per connected network and alone decides posting; `ok` / `problems` / `missingScopes` are their union
 * (`ok` = every connected network passes), kept for older readers -- `ok: false` does not mean no network can post.
 */
export type AccountCheck = {
  channelId: string;
  checkedAt: number;
  ok: boolean;
  problems: AccountCheckProblem[];
  missingScopes: string[];
  scopes: string[];
  tokenExpiresAt: number | null;
  networks: NetworkAccountCheck[];
  facebook: { stored: string; live: string | null; name: string | null } | null;
  instagram: { stored: string | null; live: string | null; username: string | null } | null;
};

/** What the runner gets for ONE network after that network's identity read passed: the Page token, the Page and the network's account. */
export type PostingTarget = { network: SocialNetwork; token: string; pageId: string; accountId: string };

export function notConfigured(): DomainError {
  return new DomainError({ code: "social_not_configured", message: "The Meta app (App ID and App Secret) is not saved on this computer yet (Settings → Channels → Social networks)." });
}
