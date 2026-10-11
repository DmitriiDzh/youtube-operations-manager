"use client";

import { useState } from "react";
import { useUiText } from "./ui-text-provider";
import { FEED_SIZES, lastFrameTime } from "./visual-review-model";

// BL-175 phase 2 (FO-REQ-0018 §E/§F, VISUAL_REVIEW_PLAN.md §7.2): two small tools of the review screen -- a picture at YouTube's
// feed sizes («Как в ленте»), and a loop clip's last and first frame side by side or as their difference («Кадры стыка»). They
// know nothing about plans: the screen gives them a URL.

const FEED_LABELS = ["review.feed.size360", "review.feed.size246", "review.feed.size168", "review.feed.size120"] as const;

/** §E: the picture at the feed sizes, on YouTube's dark and light backgrounds, with a duration badge as the feed shows it. */
export function FeedPreview({ src }: { src: string }) {
  const { t } = useUiText();
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <p className="text-xs text-zinc-400">{t("review.feed.hint")}</p>
      {(["dark", "light"] as const).map((theme) => (
        <div key={theme} className={`flex flex-wrap items-end gap-4 rounded-md p-3 ${theme === "dark" ? "bg-[#0f0f0f]" : "bg-white"}`}>
          {FEED_SIZES.map((size, i) => (
            <figure key={size.width} className="space-y-1">
              <div className={`relative overflow-hidden ${size.width >= 246 ? "rounded-xl" : "rounded-lg"}`} style={{ width: size.width, height: size.height }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a local file of this computer */}
                <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />
                {/* ui-text-ignore: a sample duration, as the feed shows one */}
                <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[11px] font-medium leading-4 text-white">10:00</span>
              </div>
              <figcaption className={`text-[11px] ${theme === "dark" ? "text-zinc-400" : "text-zinc-600"}`}>{t(FEED_LABELS[i])}</figcaption>
            </figure>
          ))}
        </div>
      ))}
    </div>
  );
}

/** §F: a loop clip's last frame and first frame, side by side or blended into their difference (black = the same). */
export function SeamFrames({ src, fps }: { src: string; fps: number | null }) {
  const { t } = useUiText();
  const [difference, setDifference] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = (which: "last" | "first") => (
    <video
      src={src}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(event) => {
        const v = event.currentTarget;
        v.currentTime = which === "last" ? lastFrameTime(v.duration, fps) : 0;
      }}
      onError={() => setFailed(true)}
      className="h-full w-full object-contain"
    />
  );
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-400">{t("review.loop.framesHint")}</span>
        <span className="ml-auto inline-flex gap-1 rounded-lg bg-zinc-900 p-1" role="group" aria-label={t("review.compare.view")}>
          {[false, true].map((d) => (
            <button key={String(d)} type="button" onClick={() => setDifference(d)} aria-pressed={difference === d} className={`rounded-md px-2.5 py-1 ${difference === d ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}>
              {d ? t("review.compare.difference") : t("review.compare.side")}
            </button>
          ))}
        </span>
      </div>
      {failed ? (
        <p className="text-sm text-red-300">{t("review.visual.loadFailed")}</p>
      ) : difference ? (
        <div className="relative h-56 overflow-hidden rounded-md bg-black [isolation:isolate]">
          <div className="absolute inset-0">{frame("last")}</div>
          <div className="absolute inset-0 mix-blend-difference">{frame("first")}</div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {(["last", "first"] as const).map((which) => (
            <figure key={which} className="space-y-1">
              <div className="h-48 overflow-hidden rounded-md bg-black">{frame(which)}</div>
              <figcaption className="text-[11px] text-zinc-400">{which === "last" ? t("review.loop.lastFrame") : t("review.loop.firstFrame")}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
