import type { DomainErrorCode } from "@/lib/video-metadata/contracts";

const DOMAIN_ERROR_STATUS = {
  validation_failed: 400,
  unauthorized: 401,
  AUTH_CALLBACK_INVALID: 401,
  AUTH_REFRESH_TOKEN_MISSING: 401,
  AUTH_USER_NOT_FOUND: 401,
  AUTH_SCOPE_INSUFFICIENT: 403,
  not_found: 404,
  target_language_unresolvable: 422,
  transcript_unavailable: 422,
  generation_failed: 422,
  update_failed: 422,
  WRITE_CHANNEL_REQUIRED: 422,
  WRITE_CHANNEL_UNRESOLVED: 422,
  WRITE_CHANNEL_MISMATCH: 409,
} as const satisfies Partial<Record<DomainErrorCode, number>>;

export function getVideoMetadataErrorStatus(code: DomainErrorCode) {
  return DOMAIN_ERROR_STATUS[code] ?? 422;
}
