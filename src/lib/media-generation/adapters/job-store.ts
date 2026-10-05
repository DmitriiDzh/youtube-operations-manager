import {
  deleteMediaWorkflowTemplate,
  getMediaExchangeFile,
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
  };
}

function templateFromDb(t: StoredMediaWorkflowTemplate): StoredTemplateRow {
  return { ...t, description: t.description ?? null, outputNodeIdsJson: t.outputNodeIdsJson ?? null, nodeCount: t.nodeCount ?? null };
}

export function createMediaJobStore(): MediaJobStore {
  return {
    templates: {
      insert: (row) => insertMediaWorkflowTemplate(row).then(templateFromDb),
      update: (id, patch) => updateMediaWorkflowTemplate(id, patch).then((t) => (t ? templateFromDb(t) : null)),
      get: (id) => getMediaWorkflowTemplateById(id).then((t) => (t ? templateFromDb(t) : null)),
      list: () => listMediaWorkflowTemplates().then((rows) => rows.map(templateFromDb)),
      delete: (id) => deleteMediaWorkflowTemplate(id),
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
  };
}
