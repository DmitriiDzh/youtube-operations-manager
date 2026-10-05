import {
  clearStoredMediaCredentials,
  getMediaGatewayEnabled,
  getMediaGenerationSettingsJson,
  getMediaModelPullsJson,
  getMediaVolumeLockHolder,
  releaseMediaVolumeLock,
  getStoredMediaCredentials,
  setMediaGatewayEnabled,
  setMediaGenerationSettingsJson,
  setStoredMediaCredentialsVerifiedAt,
  tryAcquireMediaVolumeLock,
  updateMediaModelPullsJson,
  upsertStoredMediaCredentials,
} from "@/lib/db";
import type { ModelPullStore } from "../models";
import type { MediaGenerationStore } from "../services";
import type { VolumeLockStore } from "../volume-lock";

export function createVolumeLockStore(): VolumeLockStore {
  return {
    tryAcquire: (owner) => tryAcquireMediaVolumeLock(owner),
    release: (owner) => releaseMediaVolumeLock(owner),
    holder: () => getMediaVolumeLockHolder(),
  };
}

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
