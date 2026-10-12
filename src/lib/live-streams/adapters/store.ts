import {
  deleteLiveStreamVideo,
  getLiveStream,
  updateLiveStream,
  insertLiveStreamEvent,
  listLiveStreamSources,
  listLiveStreamVideos,
  setLiveStreamRotationOrder,
  updateLiveStreamVideo,
  upsertLiveStream,
  upsertLiveStreamSource,
  upsertLiveStreamVideo,
} from "@/lib/db";
import type { LiveStreamsDependencies } from "../services";

// BL-176: the module's tables (schema v86) through db.ts's flat functions (DEVELOPMENT_PLAYBOOK §6.3).
export function createLiveStreamsStore(): LiveStreamsDependencies["store"] {
  return {
    getStream: (channelId) => getLiveStream(channelId),
    upsertStream: (row) => upsertLiveStream(row),
    updateStream: (channelId, set) => updateLiveStream(channelId, set),
    listVideos: (channelId) => listLiveStreamVideos(channelId),
    upsertVideo: (row) => upsertLiveStreamVideo(row),
    updateVideo: (channelId, videoId, set) => updateLiveStreamVideo(channelId, videoId, set),
    deleteVideo: (channelId, videoId) => deleteLiveStreamVideo(channelId, videoId),
    setOrder: (channelId, videoIds) => setLiveStreamRotationOrder(channelId, videoIds),
    insertEvent: (row) => insertLiveStreamEvent(row),
    upsertSource: (row) => upsertLiveStreamSource(row),
    listSources: (channelId) => listLiveStreamSources(channelId),
  };
}
