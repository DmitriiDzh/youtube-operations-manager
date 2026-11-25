"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { frameOf } from "./media-frame";
import { useT } from "./ui-text-provider";
import { VideoDetailModal } from "./video-detail-modal";

// BL-260 (owner msg 4421): «кликнуть на видео и чтобы в поп ап запустился медиа проигрыватель» -- on «План недели», the calendar and
// «Ролики и релизы». The package's own mp4 on this computer first (HTTP Range through the package-review video route: nothing is
// downloaded before play, any length); when it is not here (deleted after upload, or never on this computer) and the video is on
// YouTube, YouTube's own player (youtube-nocookie) with a link to the video -- a private or scheduled video plays only there.

export type VideoPopupTarget = { title: string; manifestSha256?: string | null; videoId?: string | null };

/** Whether there is anything to play: a package (its manifest) or a YouTube video. */
export const canPlay = (target: Pick<VideoPopupTarget, "manifestSha256" | "videoId">): boolean => Boolean(target.manifestSha256 || target.videoId);

/** The URLs the popup uses (pure, for tests). */
export function popupSources(channelId: string, target: Pick<VideoPopupTarget, "manifestSha256" | "videoId">): { local: string | null; embed: string | null; watch: string | null } {
  return {
    local: target.manifestSha256 ? `/api/channels/${encodeURIComponent(channelId)}/package-reviews/video?manifest=${encodeURIComponent(target.manifestSha256)}` : null,
    embed: target.videoId ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(target.videoId)}?autoplay=1&rel=0` : null,
    watch: target.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(target.videoId)}` : null,
  };
}

export function VideoPopup({ channelId, target, onClose }: { channelId: string; target: VideoPopupTarget; onClose: () => void }) {
  const t = useT();
  const sources = popupSources(channelId, target);
  const [localFailed, setLocalFailed] = useState(false);
  const [frame, setFrame] = useState<"vertical" | "horizontal">("horizontal");
  const useLocal = sources.local !== null && !localFailed;
  return (
    <VideoDetailModal title={target.title} onClose={onClose} widthClassName={frame === "vertical" && useLocal ? "max-w-md" : "max-w-4xl"}>
      <div className="space-y-3">
        {useLocal ? (
          <div className={frame === "vertical" ? "mx-auto w-full max-w-sm" : "w-full"}>
            <video
              src={sources.local!}
              controls
              autoPlay
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => setFrame(frameOf(event.currentTarget.videoWidth, event.currentTarget.videoHeight))}
              onError={() => setLocalFailed(true)}
              className={`${frame === "vertical" ? "aspect-[9/16] max-h-[75vh]" : "aspect-video"} w-full rounded-md bg-black object-contain`}
            />
          </div>
        ) : sources.embed ? (
          <iframe
            src={sources.embed}
            title={target.title}
            // ui-text-ignore: the iframe's permission list, not interface text
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="aspect-video w-full rounded-md bg-black"
          />
        ) : (
          <p className="rounded-md border border-orange-900 bg-orange-950/40 px-3 py-2 text-sm text-orange-200">{t("videoPopup.unavailable")}</p>
        )}
        {!useLocal && sources.embed && <p className="text-xs text-zinc-400">{t("videoPopup.fromYoutube")}</p>}
        {sources.watch && (
          <a href={sources.watch} target="_blank" rel="noreferrer" className="inline-block text-xs text-zinc-300 underline hover:text-white">
            {t("videoPopup.openOnYoutube")}
          </a>
        )}
      </div>
    </VideoDetailModal>
  );
}

/** A small «▶» that opens the popup; nothing when there is nothing to play. */
export function VideoPlayButton({ channelId, target, className = "" }: { channelId: string; target: VideoPopupTarget; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!canPlay(target)) return null;
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={t("videoPopup.play", { title: target.title })}
        title={t("videoPopup.play", { title: target.title })}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-600 text-[10px] text-zinc-200 hover:border-accent hover:text-white ${className}`}
      >
        ▶
      </button>
      {/* Review: in a portal, so the popup never inherits the row's styles (a truncated, nowrap title would clip its texts). */}
      {open && typeof document !== "undefined" && createPortal(<VideoPopup channelId={channelId} target={target} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
