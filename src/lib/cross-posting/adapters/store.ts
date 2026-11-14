import { deleteSocialAccounts, getStoredChannel, listSocialAccounts, upsertSocialAccount, type StoredSocialAccount } from "@/lib/db";
import type { SocialAccountRow } from "../contracts";
import type { CrossPostingStore } from "../services";

// BL-252: the module's database access, through `db.ts`'s helpers only.
function toRow(r: StoredSocialAccount): SocialAccountRow {
  return {
    channelId: r.channelId,
    network: r.network,
    externalId: r.externalId,
    displayName: r.displayName,
    username: r.username,
    pageId: r.pageId,
    tokenSealed: r.tokenSealed,
    tokenExpiresAt: r.tokenExpiresAt ? r.tokenExpiresAt.getTime() : null,
    connectedAt: r.connectedAt.getTime(),
  };
}

export function createCrossPostingStore(): CrossPostingStore {
  return {
    channelExists: async (channelId) => (await getStoredChannel(channelId)) !== null,
    list: async (channelId) => (await listSocialAccounts(channelId)).map(toRow),
    upsert: (row) =>
      upsertSocialAccount({ ...row, tokenExpiresAt: row.tokenExpiresAt === null ? null : new Date(row.tokenExpiresAt), connectedAt: new Date(row.connectedAt) }),
    remove: (channelId, network) => deleteSocialAccounts(channelId, network),
  };
}
