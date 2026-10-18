import {
  getMediaGatewayEnabled,
  getMediaGenerationSettingsJson,
  getMediaModelPullsJson,
  getMediaVolumeLockHolder,
  releaseMediaVolumeLock,
  insertMediaControlEvent,
  setMediaGatewayEnabled,
  setMediaGenerationSettingsJson,
  tryAcquireMediaVolumeLock,
  updateMediaModelPullsJson,
} from "@/lib/db";
import type { MediaControlEvent, ModelPullStore } from "../models";
import type { MediaGenerationStore } from "../services";
import type { VolumeLockStore } from "../volume-lock";

export function createVolumeLockStore(): VolumeLockStore {
  return {
    tryAcquire: (owner, at) => tryAcquireMediaVolumeLock(owner, at),
    release: (owner) => releaseMediaVolumeLock(owner),
    holder: () => getMediaVolumeLockHolder(),
  };
}

/** BL-132 audit sink (`media_control_events`). */
export function createMediaControlEventSink(): { record(event: MediaControlEvent): Promise<void> } {
  return {
    record: (event) =>
      insertMediaControlEvent({ at: new Date(), actor: event.actor, action: event.action, subject: event.subject, detailsJson: event.details ? JSON.stringify(event.details) : null }),
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
    getSettingsJson: () => getMediaGenerationSettingsJson(),
    setSettingsJson: (json) => setMediaGenerationSettingsJson(json),
    getGatewayEnabled: () => getMediaGatewayEnabled(),
    setGatewayEnabled: (enabled) => setMediaGatewayEnabled(enabled),
  };
}
