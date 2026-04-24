import {
  DomainError,
  isDomainError,
  type CredentialRef,
  type DomainErrorCode,
  type DomainErrorShape,
  type ResolvedCredentials,
} from "@/lib/video-metadata/contracts";

export type {
  CredentialRef,
  DomainErrorCode,
  DomainErrorShape,
  ResolvedCredentials,
};

export { DomainError, isDomainError };

export type Playlist = {
  id: string;
  title: string;
  description: string;
  privacyStatus: PlaylistPrivacyStatus;
};

export type PlaylistPrivacyStatus = "private" | "public" | "unlisted";

export type DeletePlaylistResult = {
  deleted: true;
  playlistId: string;
};

export type UpdatePlaylistInput = {
  credentialRef: CredentialRef;
  playlistId: string;
  expectedChannelId: string;
  title?: string;
  description?: string;
  privacyStatus?: PlaylistPrivacyStatus;
};

export type UpdatePlaylistResult = {
  playlist: Playlist;
};

export type PlaylistMutationFailureReason =
  | "already-present"
  | "not-found-in-playlist"
  | "forbidden"
  | "api-error"
  | "unknown";

export type PlaylistMutationFailure = {
  videoId: string;
  reason: PlaylistMutationFailureReason;
  message?: string;
};

export type AddVideosResult = {
  playlistId: string;
  attempted: number;
  added: number;
  failures: PlaylistMutationFailure[];
};

export type RemoveVideosResult = {
  playlistId: string;
  requested: number;
  removed: number;
  failures: PlaylistMutationFailure[];
};
