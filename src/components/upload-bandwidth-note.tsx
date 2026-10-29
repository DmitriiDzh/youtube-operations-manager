"use client";

import { useEffect, useState } from "react";
import { useT } from "./ui-text-provider";

// BL-233 (FO-REQ-0047): one line under a running stream and over the uploads list when a video upload on this computer is limited
// or paused for the live streams. Nothing is shown while no upload runs, or when no limit applies.

type Report = { active: boolean; limit: "none" | "limited" | "held"; capMbps: number; heldSince: string | null } | null;

const POLL_MS = 15_000;

export function UploadBandwidthNote() {
  const t = useT();
  const [report, setReport] = useState<Report>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch("/api/publishing/upload-bandwidth");
        const body = (await response.json().catch(() => null)) as { upload?: Report } | null;
        if (!stopped) setReport(response.ok ? (body?.upload ?? null) : null);
      } catch {
        if (!stopped) setReport(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!report || !report.active || report.limit === "none") return null;
  if (report.limit === "held") {
    const at = report.heldSince ? new Date(report.heldSince).toLocaleTimeString(t.language, { hour: "2-digit", minute: "2-digit" }) : "—";
    return <p className="text-xs text-amber-300">{t("live.upload.held", { at })}</p>;
  }
  return <p className="text-xs text-sky-300">{t("live.upload.limited", { mbps: report.capMbps.toLocaleString(t.language) })}</p>;
}
