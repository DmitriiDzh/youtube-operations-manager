import { createPackageCaptionsHandlers } from "./handlers";

// BL-269 (ADR 0074 §8, §10): the owner's captions of an uploaded package (preview with `dryRun`, then apply; `overwrite` replaces).
export const { POST } = createPackageCaptionsHandlers();
