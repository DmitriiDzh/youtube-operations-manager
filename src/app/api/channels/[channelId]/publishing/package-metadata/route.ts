import { createPackageMetadataHandlers } from "./handlers";

// BL-265 (ADR 0072 §5): the owner's packaging fix of an uploaded video (preview with `dryRun`, then apply).
export const { POST } = createPackageMetadataHandlers();
