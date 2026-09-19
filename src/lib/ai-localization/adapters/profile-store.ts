import {
  createGenerationProvenance,
  getGenerationProvenanceByChangeSetId,
  getStoredEditorialProfile,
  upsertStoredEditorialProfile,
} from "@/lib/db";

export function createEditorialProfileStoreAdapter() {
  return {
    getProfile: getStoredEditorialProfile,
    saveProfile: upsertStoredEditorialProfile,
  };
}

export function createGenerationProvenanceStoreAdapter() {
  return {
    create: createGenerationProvenance,
    getByChangeSetId: getGenerationProvenanceByChangeSetId,
  };
}
