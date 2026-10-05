import {
  clearStoredMediaCredentials,
  getMediaGatewayEnabled,
  getMediaGenerationSettingsJson,
  getStoredMediaCredentials,
  setMediaGatewayEnabled,
  setMediaGenerationSettingsJson,
  setStoredMediaCredentialsVerifiedAt,
  upsertStoredMediaCredentials,
} from "@/lib/db";
import type { MediaGenerationStore } from "../services";

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
