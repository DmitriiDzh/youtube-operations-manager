import {
  clearStoredMediaCredentials,
  getMediaGatewayEnabled,
  getMediaGenerationSettingsJson,
  getMediaModelPullsJson,
  getStoredMediaCredentials,
  setMediaGatewayEnabled,
  setMediaGenerationSettingsJson,
  setStoredMediaCredentialsVerifiedAt,
  updateMediaModelPullsJson,
  upsertStoredMediaCredentials,
} from "@/lib/db";
import type { ModelPullStore } from "../models";
import type { MediaGenerationStore } from "../services";

export function createModelPullStore(): ModelPullStore {
  return {
    getPullsJson: () => getMediaModelPullsJson(),
    updatePullsJson: (mutate) => updateMediaModelPullsJson(mutate),
  };
}

export function createMediaGenerationStore(): MediaGenerationStore {
  return {
    getCredentials: () => getStoredMediaCredentials(),
    upsertCredentials: (input) => upsertStoredMediaCredentials(input),
    setCredentialsVerifiedAt: (at) => setStoredMediaCredentialsVerifiedAt(at),
    clearCredentials: () => clearStoredMediaCredentials(),
    getSettingsJson: () => getMediaGenerationSettingsJson(),
    setSettingsJson: (json) => setMediaGenerationSettingsJson(json),
    getGatewayEnabled: () => getMediaGatewayEnabled(),
    setGatewayEnabled: (enabled) => setMediaGatewayEnabled(enabled),
  };
}
