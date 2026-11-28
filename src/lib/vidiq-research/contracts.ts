import type { VidiqLedgerOutcome, VidiqLedgerRow, VidiqSettingKey } from "@/lib/db";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077 decisions 5 and 7, VIDIQ_INTEGRATION_PLAN.md §5 stage 1): the vidIQ research module's contracts. It owns the
// switch, the key's use, the credits ledger, the budget and the balance snapshot, and is the only user of `@/lib/vidiq-gateway`.
// Off by default; on only with a saved key (the first verified save turns it on, clearing turns it off). Every vidIQ number is a
// third-party estimate; nothing here stores vidIQ data as YTM evidence. No background work of any kind.
// ---------------------------------------------------------------------------

export { DomainError, isDomainError } from "@/lib/shared-domain";
export type { VidiqLedgerOutcome, VidiqLedgerRow, VidiqSettingKey };

export type VidiqCaller = "owner" | "producer";

/** Default budget: the Free tier's 150 credits a month (plan §5). */
export const VIDIQ_DEFAULT_MONTHLY_BUDGET = 150;
export const VIDIQ_MAX_MONTHLY_BUDGET = 100_000;
/** A balance snapshot older than this is re-read (free) before a paid call. */
export const VIDIQ_BALANCE_MAX_AGE_MS = 10 * 60_000;
/** A `pending` row older than this belongs to a call whose process ended mid-call: it becomes `unknown` (ADR 0077 amendment 1). */
export const VIDIQ_PENDING_STALE_MS = 15 * 60_000;
/** The Settings card's ledger rows. */
export const VIDIQ_RECENT_LEDGER_ROWS = 20;

export type VidiqBalanceSnapshot = {
  type: string | null;
  planName: string | null;
  totalCredits: number;
  renewableCredits: number | null;
  maxRenewableCredits: number | null;
  renewableResetsAt: string;
  addOnCredits: number | null;
  maxAddOnCredits: number | null;
  readAt: string;
  /** The device-secret version of the key it was read with: a new key discards it. */
  keyVersion: string;
};

export type VidiqKeyView = {
  state: "set" | "none" | "key_file_missing" | "key_file_invalid";
  /** The key's last 4 characters, never more. */
  hint: string | null;
  /** `ok`: vidIQ accepted it at the last check; `invalid`: vidIQ refused it since. */
  status: "ok" | "invalid" | null;
  verifiedAt: string | null;
};

export type VidiqBudgetView = { monthly: number; spentInPeriod: number; remaining: number; periodStartsAt: string; periodEndsAt: string };

export type VidiqLedgerView = Omit<VidiqLedgerRow, "at"> & { at: string };

export type VidiqStatusView = {
  key: VidiqKeyView;
  enabled: boolean;
  balance: Omit<VidiqBalanceSnapshot, "keyVersion"> | null;
  budget: VidiqBudgetView;
  ledger: VidiqLedgerView[];
  /** Tools blocked because vidIQ charged more than their pin, until the owner acknowledges it (ADR 0077 amendment 1); sorted. */
  overchargedTools: string[];
};

export type VidiqCallResult = {
  tool: string;
  statedCost: number;
  creditsSpent: number;
  isError: boolean;
  result: unknown;
  job: { mcpJobId: string; status: string } | null;
  balance: { totalCredits: number; renewableResetsAt: string } | null;
  budget: VidiqBudgetView;
};

/** The module's database access (db.ts helpers in production, an in-memory map in tests). */
export type VidiqStore = {
  getSetting(key: VidiqSettingKey): Promise<string | null>;
  setSetting(key: VidiqSettingKey, value: string | null): Promise<void>;
  insertLedger(row: Omit<VidiqLedgerRow, "id">): Promise<number>;
  updateLedger(id: number, patch: Partial<Pick<VidiqLedgerRow, "outcome" | "creditsUsed" | "errorCode" | "jobId" | "balanceAfter">>): Promise<void>;
  /** Newest first, within the 90-day retention; `since` inclusive. */
  listLedger(input: { limit: number; since?: Date; now?: Date }): Promise<VidiqLedgerRow[]>;
  hasPendingJob(jobId: string): Promise<boolean>;
  /** `pending` rows recorded before `before` become `unknown` (`vidiq_outcome_unknown`, credits still unknown); returns how many. */
  expireStalePending(before: Date): Promise<number>;
};
