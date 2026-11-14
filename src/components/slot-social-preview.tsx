"use client";

import { useEffect, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

// BL-252 stage 2 (AC-XP-15, ADR 0068 amendment 1): on «План недели», under a slot whose package carries a `crossPost` block --
// which networks the same video also goes to, with which text, and whether anything stops it. Approving the slot approves this too
// (the block is part of the approved manifest). Shows nothing when the package posts nowhere else.

type Target = { network: "instagram" | "facebook"; caption?: string; title?: string | null; description?: string; at: string | null };
type Preview = { targets: Target[]; problems: Array<{ network: string | null; code: string; params?: Record<string, string | number> }>; jobs: Array<{ network: string; status: string; permalink: string | null; errorCode: string | null }> };

export function SlotSocialPreview(props: { channelId: string; video: string; manifestSha256: string | null; slotTime: string }) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!props.manifestSha256) return;
    const q = new URLSearchParams({ channelId: props.channelId, video: props.video, manifestSha256: props.manifestSha256 });
    let cancelled = false;
    fetch(`/api/social/slot?${q}`)
      .then((r) => (r.ok ? (r.json() as Promise<Preview>) : null))
      .then((p) => !cancelled && setPreview(p), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.channelId, props.video, props.manifestSha256]);
  if (!preview || (preview.targets.length === 0 && preview.problems.length === 0)) return null;
  const networkName = (n: string) => (n === "instagram" || n === "facebook" ? t(`social.network.${n}`) : n);
  return (
    <details className="px-4 pb-3 text-xs text-zinc-300">
      <summary className="cursor-pointer text-zinc-400">
        {t("social.slot.summary", { networks: preview.targets.map((x) => networkName(x.network)).join(" · ") || "—" })}
        {preview.problems.length > 0 && <span className="ml-2 text-amber-400">{t("social.slot.problems", { count: preview.problems.length })}</span>}
      </summary>
      <ul className="mt-2 space-y-2">
        {preview.targets.map((x) => {
          const job = preview.jobs.find((j) => j.network === x.network);
          return (
            <li key={x.network} className="rounded-md border border-zinc-800 p-2">
              <div className="mb-1 flex flex-wrap gap-2 text-zinc-400">
                <span className="font-medium text-zinc-200">{networkName(x.network)}</span>
                <span>{t("social.slot.at", { time: x.at ?? props.slotTime })}</span>
                {job && <span className={job.status === "published" ? "text-emerald-400" : job.status === "failed" ? "text-red-400" : "text-amber-300"}>{t(`social.job.${job.status}` as UiTextKey)}</span>}
                {job?.permalink && (
                  <a href={job.permalink} target="_blank" rel="noreferrer" className="text-sky-400 underline">
                    {t("social.job.open")}
                  </a>
                )}
              </div>
              {x.title && <div className="font-medium text-zinc-200">{x.title}</div>}
              <div className="whitespace-pre-wrap break-words">{x.caption ?? x.description}</div>
            </li>
          );
        })}
      </ul>
      {preview.problems.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-amber-400">
          {preview.problems.map((p, i) => (
            <li key={i}>
              {p.network ? `${networkName(p.network)}: ` : ""}
              {t("social.slot.problem", { code: p.code })}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-zinc-500">{t("social.slot.note")}</p>
    </details>
  );
}
