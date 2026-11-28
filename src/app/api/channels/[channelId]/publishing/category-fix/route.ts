import { createCategoryFixHandlers } from "./handlers";

// BL-279 (owner TG 4963/4964, ADR 0072 amendment 2): the owner's category fix of the channel's package-uploaded videos (preview with
// `dryRun`, then apply).
export const { POST } = createCategoryFixHandlers();
