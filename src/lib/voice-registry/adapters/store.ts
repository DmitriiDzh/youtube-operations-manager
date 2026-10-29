import { getChannelVoice, insertChannelVoice, listChannelVoices, updateChannelVoice } from "@/lib/db";
import type { VoiceStore } from "../services";

// BL-236: the registry's database access, through `db.ts`'s helpers only.
export function createVoiceStore(): VoiceStore {
  return {
    insert: (row) => insertChannelVoice(row),
    get: (voiceId) => getChannelVoice(voiceId),
    list: (filter) => listChannelVoices(filter),
    update: (voiceId, fromStatus, set) => updateChannelVoice(voiceId, fromStatus, set),
  };
}
