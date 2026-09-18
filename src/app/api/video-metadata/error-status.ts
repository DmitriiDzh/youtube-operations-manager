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
  change_not_approvable: 409,
  batch_invalid_selection: 400,
  batch_not_found: 404,
  batch_already_running: 409,
  ledger_row_not_found: 404,
  ledger_invalid_transition: 409,
  video_locked: 409,
  attempt_already_resolved: 409,
  attempt_already_active: 409,
  change_approval_invalid: 409,
  default_language_missing: 422,
  backup_item_failed: 422,
  backup_infrastructure_unavailable: 503,
  live_writes_disabled: 503,
} as const satisfies Partial<Record<DomainErrorCode, number>>;

export function getVideoMetadataErrorStatus(code: DomainErrorCode) {
  return DOMAIN_ERROR_STATUS[code] ?? 422;
}
