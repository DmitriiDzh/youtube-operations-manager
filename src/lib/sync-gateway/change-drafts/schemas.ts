import { z } from "zod";
import { CREATED_VIA_VALUES } from "@/lib/shared-provenance";
export { parseWithSchema, formatZodError } from "./contracts";


const changeFieldSchema = z.enum(["title", "description"]);
const changeTypeSchema = z.enum(["add", "modify", "unchanged", "delete"]);
const changeSetSourceSchema = z.enum(["xlsx_import", "ai_localization", "deletion"]);
const changeSetStatusSchema = z.enum(["in_review", "approved", "partially_approved", "rejected"]);
const changeValidationStatusSchema = z.enum(["valid", "invalid"]);
const changeConflictStatusSchema = z.enum(["none", "conflict"]);
const changeApprovalStatusSchema = z.enum(["pending", "approved", "rejected"]);

export const createChangeSetInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    source: changeSetSourceSchema,
    importedFilename: z.string().nullable().optional(),
    schemaVersion: z.string().nullable().optional(),
    exportedAt: z.string().nullable().optional(),
  })
  .strict();

export const createProvenanceInputSchema = z
  .object({
    channelId: z.string().min(1),
    id: z.string().min(1),
    changeSetId: z.string().min(1),
    profileVersion: z.number().nullable(),
    effectiveContextJson: z.string().nullable(),
    // Phase 7 slice F -- additive and optional (omitted defaults to `null` in the service
    // function below, same as every pre-existing caller/test that predates this field).
    // `evidenceJson`/`rationale` are caller-supplied (agent-authored claims); `createdVia`/
    // `agentApiVersion` are stamped by the caller layer (MCP/CLI/Web route), never by this module
    // itself -- this schema just carries whatever it's given through.
    evidenceJson: z.string().nullable().optional(),
    rationale: z.string().nullable().optional(),
    createdVia: z.enum(CREATED_VIA_VALUES).nullable().optional(),
    agentApiVersion: z.string().nullable().optional(),
  })
  .strict();

export const addChangeInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    changeSetId: z.string().min(1),
    videoId: z.string().min(1),
    language: z.string().min(1),
    field: changeFieldSchema,
    baselineValue: z.string(),
    proposedValue: z.string(),
    changeType: changeTypeSchema,
    // Optional -- default to "valid"/null/"none" (the interactive/AI-generation case, where a
    // change is created already known-good). An importer (e.g. XLSX import) that has already
    // computed real per-row validation/conflict results passes them explicitly here instead of
    // silently discarding that information -- see src/lib/changesets/adapters/change-drafts-store.ts.
    validationStatus: changeValidationStatusSchema.optional(),
    validationError: z.string().nullable().optional(),
    conflictStatus: changeConflictStatusSchema.optional(),
  })
  .strict();

const changeToAddSchema = z
  .object({
    changeId: z.string().min(1),
    videoId: z.string().min(1),
    language: z.string().min(1),
    field: changeFieldSchema,
    baselineValue: z.string(),
    proposedValue: z.string(),
    changeType: changeTypeSchema,
    validationStatus: changeValidationStatusSchema.optional(),
    validationError: z.string().nullable().optional(),
    conflictStatus: changeConflictStatusSchema.optional(),
  })
  .strict();

// A change set plus all of its changes and (optionally) a non-default initial status, applied as
// a SINGLE Automerge.change + a single saveDocument call -- see services.ts's
// `createChangeSetWithChanges` doc comment for why: the old direct-SQL adapter wrapped the
// equivalent write in one db.transaction (AGENTS.md §K.3 data-preservation invariant), and this
// batched form is what preserves that same all-or-nothing guarantee on the Automerge side.
export const createChangeSetWithChangesInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    source: changeSetSourceSchema,
    importedFilename: z.string().nullable().optional(),
    schemaVersion: z.string().nullable().optional(),
    exportedAt: z.string().nullable().optional(),
    initialStatus: changeSetStatusSchema.optional(),
    changes: z.array(changeToAddSchema),
  })
  .strict();

const changePatchSchema = z
  .object({
    conflictStatus: changeConflictStatusSchema.optional(),
    approvalStatus: changeApprovalStatusSchema.optional(),
    approvedValue: z.string().nullable().optional(),
  })
  .strict();

// Same atomicity rationale as `createChangeSetWithChangesInputSchema` above, for the
// approve-all/reject-all/revalidation-dirty-write bulk-patch case.
export const bulkPatchChangesInputSchema = z
  .object({
    channelId: z.string().min(1),
    updates: z.array(
      z
        .object({
          changeId: z.string().min(1),
          patch: changePatchSchema,
        })
        .strict()
    ),
  })
  .strict();

export const setChangeSetStatusInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeSetId: z.string().min(1),
    status: changeSetStatusSchema,
  })
  .strict();

export const patchChangeInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    patch: z
      .object({
        conflictStatus: changeConflictStatusSchema.optional(),
        approvalStatus: changeApprovalStatusSchema.optional(),
        approvedValue: z.string().nullable().optional(),
      })
      .strict(),
  })
  .strict();

export const updateProposedValueInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    proposedValue: z.string(),
  })
  .strict();

export const setApprovalStatusInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    approvalStatus: changeApprovalStatusSchema,
    approvedValue: z.string().nullable().optional(),
  })
  .strict();

export const channelIdInputSchema = z
  .object({
    channelId: z.string().min(1),
  })
  .strict();

export const mergeIncomingInputSchema = z
  .object({
    channelId: z.string().min(1),
    incomingBytes: z.instanceof(Uint8Array),
  })
  .strict();

// RISK-46 (docs/TECHNICAL_DEBT.md): an operator-triggered, explicit "discard my local copy,
// adopt this peer's version instead" resolution for a channel whose document diverged (no shared
// history, `divergent_document_lineage`). Same shape as `mergeIncomingInputSchema` -- this is
// deliberately not a merge.
export const discardLocalAndAdoptPeerInputSchema = z
  .object({
    channelId: z.string().min(1),
    incomingBytes: z.instanceof(Uint8Array),
  })
  .strict();

// The only fields realistic for two devices to actually conflict on in practice: an operator
// editing an AI-generated proposal, or racing an approve/reject decision. `baselineValue`/
// `changeType`/`validationStatus`/`validationError`/the identity fields are set once at
// creation and never re-edited by this module's own API, so a conflict on one of them would
// indicate something unexpected -- deliberately not resolvable through this narrower surface.
const resolvableConflictFieldSchema = z.enum(["proposedValue", "approvalStatus", "approvedValue", "conflictStatus"]);

// Deliberately takes `winningActorId`, never a raw `value` -- the server re-derives the actual
// value from Automerge's own recorded conflict (`Automerge.getConflicts`) rather than trusting a
// client-supplied string, so this can never write a value that wasn't already one of the
// genuinely-conflicting options a device produced through the normal validated write paths.
export const resolveConflictInputSchema = z
  .object({
    channelId: z.string().min(1),
    changeId: z.string().min(1),
    field: resolvableConflictFieldSchema,
    winningActorId: z.string().min(1),
  })
  .strict();
