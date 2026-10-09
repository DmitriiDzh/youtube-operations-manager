"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { RoleAgentTokenSettings } from "./role-agent-token-settings";
import { useT } from "./ui-text-provider";

type ProducerCall = { at: string; tool: string; channelId: string | null; channelTitle: string | null; outcome: "ok" | "error"; errorCode: string | null };

/** BL-161 (FO-REQ-0012 §2.4): the Producer's newest calls on this computer -- what it looked at, for which channel, refused or not. */
function ProducerCallLog() {
  const t = useT();
  const [calls, setCalls] = useState<ProducerCall[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch("/api/producer-agent-token/calls");
      if (!res.ok) throw new Error("load failed");
      setCalls(((await res.json()) as { calls: ProducerCall[] }).calls);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        {t("settingsCards.producerCalls.title")}
        <button onClick={() => load()} className="text-zinc-500 underline hover:text-zinc-300">
          {t("settingsCards.producerCalls.refresh")}
        </button>
      </div>
      {failed && <p className="text-xs text-red-400">{t("settingsCards.producerCalls.loadFailed")}</p>}
      {calls && calls.length === 0 && <p className="text-xs text-zinc-500">{t("settingsCards.producerCalls.empty")}</p>}
      {calls && calls.length > 0 && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-zinc-800 p-2 font-mono text-[11px] text-zinc-400">
          {calls.map((call, index) => (
            <li key={`${call.at}-${index}`} className="flex flex-wrap gap-x-2">
              <span className="text-zinc-500">{formatDisplayDateTime(call.at)}</span>
              <span className="text-zinc-200">{call.tool}</span>
              <span>{call.channelId ? (call.channelTitle ?? call.channelId) : "—"}</span>
              {call.outcome === "error" && (
                <span className="text-red-400">
                  {t("settingsCards.producerCalls.failed")}
                  {call.errorCode ? ` (${call.errorCode})` : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** BL-161 -- the Producer role's token card (the shared role-token card on `/api/producer-agent-token`) and its call log. */
export function ProducerAgentTokenSettings() {
  return (
    <RoleAgentTokenSettings
      endpoint="/api/producer-agent-token"
      placeholder="ytom_pr_..."
      texts={{
        title: "settingsCard.producerToken",
        info: "settingsCards.producerToken.info",
        loadFailed: "settingsCards.producerToken.loadFailed",
        statusUnknown: "settingsCards.producerToken.statusUnknown",
        rotateTitle: "settingsCards.producerToken.rotateTitle",
        revokeTitle: "settingsCards.producerToken.revokeTitle",
        rotateBody: "settingsCards.producerToken.rotateBody",
        revokeBody: "settingsCards.producerToken.revokeBody",
      }}
    >
      <ProducerCallLog />
    </RoleAgentTokenSettings>
  );
}
