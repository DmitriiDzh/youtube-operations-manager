import {
  deleteMediaWorkflowTemplate,
  getMediaExchangeFile,
  getMediaExchangeInput,
  insertMediaExchangeInput,
  listMediaExchangeInputsByJob,
  markMediaExchangeInputRemoteDeleted,
  getMediaJobById,
  getMediaWorkflowTemplateById,
  insertMediaJob,
  insertMediaWorkflowTemplate,
  listMediaJobs,
  listMediaWorkflowTemplates,
  listNonTerminalMediaJobs,
  markMediaExchangeFileRemoteDeleted,
  transitionMediaJob,
  updateMediaWorkflowTemplate,
  upsertFactoryMediaWorkflowTemplate,
  upsertMediaExchangeFile,
  type StoredMediaJob,
  type StoredMediaWorkflowTemplate,
} from "@/lib/db";
import type { MediaJobStore, StoredJobRow, StoredTemplateRow } from "../jobs";

function jobFromDb(row: StoredMediaJob): StoredJobRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    channelId: row.channelId,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    paramsJson: row.paramsJson,
    status: row.status,
    createdBy: row.createdBy,
    promptId: row.promptId ?? null,
    outputsJson: row.outputsJson ?? null,
    assetIdsJson: row.assetIdsJson ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    planId: row.planId ?? null,
    planStageId: row.planStageId ?? null,
    planItemKey: row.planItemKey ?? null,
    planSeed: row.planSeed ?? null,
  };
}

function templateFromDb(t: StoredMediaWorkflowTemplate): StoredTemplateRow {
  return {
    ...t,
    description: t.description ?? null,
    outputNodeIdsJson: t.outputNodeIdsJson ?? null,
    nodeCount: t.nodeCount ?? null,
    source: t.source === "factory" ? "factory" : "owner",
    registrySha256: t.registrySha256 ?? null,
    modelsJson: t.modelsJson ?? null,
    gpuJson: t.gpuJson ?? null,
  };
}

export function createMediaJobStore(): MediaJobStore {
  return {
    templates: {
      insert: (row) => insertMediaWorkflowTemplate(row).then(templateFromDb),
      update: (id, patch) => updateMediaWorkflowTemplate(id, patch).then((t) => (t ? templateFromDb(t) : null)),
      get: (id) => getMediaWorkflowTemplateById(id).then((t) => (t ? templateFromDb(t) : null)),
      list: () => listMediaWorkflowTemplates().then((rows) => rows.map(templateFromDb)),
      delete: (id) => deleteMediaWorkflowTemplate(id),
      upsertFactory: (row) => upsertFactoryMediaWorkflowTemplate(row).then((t) => (t ? templateFromDb(t) : null)),
    },
    jobs: {
      insert: (row) => insertMediaJob(row).then(jobFromDb),
      get: (id) => getMediaJobById(id).then((r) => (r ? jobFromDb(r) : null)),
      list: (filter) => listMediaJobs(filter).then((rows) => rows.map(jobFromDb)),
      listNonTerminal: () => listNonTerminalMediaJobs().then((rows) => rows.map(jobFromDb)),
      transition: (id, from, set) => transitionMediaJob(id, from, set).then((r) => (r ? jobFromDb(r) : null)),
    },
    ledger: {
      upsert: (row) => upsertMediaExchangeFile(row),
      markRemoteDeleted: (key, at) => markMediaExchangeFileRemoteDeleted(key, at),
      get: (key) => getMediaExchangeFile(key).then((r) => (r ? { ...r, remoteDeletedAt: r.remoteDeletedAt ?? null } : null)),
    },
    inputs: {
      insert: (row) => insertMediaExchangeInput(row),
      listByJob: (jobId) => listMediaExchangeInputsByJob(jobId).then((rows) => rows.map((r) => ({ ...r, remoteDeletedAt: r.remoteDeletedAt ?? null }))),
      get: (key) => getMediaExchangeInput(key).then((r) => (r ? { ...r, remoteDeletedAt: r.remoteDeletedAt ?? null } : null)),
      markRemoteDeleted: (key, at) => markMediaExchangeInputRemoteDeleted(key, at),
    },
  };
}
