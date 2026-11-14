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

export type MetaAppStatus = { configured: boolean; appId: string | null };

export function notConfigured(): DomainError {
  return new DomainError({ code: "social_not_configured", message: "The Meta app (App ID and App Secret) is not saved on this computer yet (Settings → Channels → Social networks)." });
}
