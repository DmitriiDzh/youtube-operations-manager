"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceSyncDivergenceCard } from "./device-sync-divergence-card";
import { SETTING_LABELS, formatValue, listDiff, settingLabel, wordDiff, type DiffToken } from "./conflict-values";

// Owner, Telegram 2026-10-07 (msgs 2011/2013): every difference between the two computers on one screen, decided in one go --
// shown blocking on the startup window and, without blocking, in Merge. Each conflict is a card with the two versions side by
// side and a "Keep this" under each; the choice goes to both computers at once. Uses the families' own conflict and resolve
// routes; adds no new way to resolve anything.

type SettingConflict = { field: string; values: unknown[]; thisComputer: unknown };
type ActorConflict = {
  family: "change_drafts" | "editorial_profile" | "ai_connections";
  key: string;
  group: string;
  subject: string;
  field: string;
  channelId?: string;
  changeId?: string;
  connectionId?: string;
  valuesByActor: Record<string, unknown>;
  resolvable: boolean;
};

const RESOLVABLE_CHANGE_DRAFT_FIELDS = new Set(["proposedValue", "approvalStatus", "approvedValue", "conflictStatus"]);
const FIELD_LABELS: Record<string, string> = {
  proposedValue: "Proposed text",
  approvedValue: "Approved text",
  approvalStatus: "Approval",
  conflictStatus: "Conflict state",
  targetAudience: "Target audience",
  toneNotes: "Tone",
  terminologyNotes: "Terminology",
  titleConstraints: "Title rules",
  descriptionConstraints: "Description rules",
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok && res.status !== 207) throw new Error(data?.message ?? `Request to ${url} failed (${res.status})`);
  return data;
}

export type ConflictCenterState = {
  loaded: boolean;
  settings: SettingConflict[];
  others: ActorConflict[];
  divergence: boolean;
  error: string | null;
  total: number;
  refresh: () => Promise<void>;
};

/** Every conflict this device knows of: Setup settings, the snapshot divergence, and every connected channel's drafts and profile. */
export function useConflictCenter(enabled: boolean): ConflictCenterState {
  const [settings, setSettings] = useState<SettingConflict[]>([]);
  const [others, setOthers] = useState<ActorConflict[]>([]);
  const [divergence, setDivergence] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const errors: string[] = [];
    const settled = await Promise.allSettled([
      fetchJson<{ conflicts?: SettingConflict[] }>("/api/media-generation/settings-sync"),
      fetchJson<{ notices?: Array<{ kind: string; snapshotId?: string | null }> }>("/api/device-sync/status"),
      fetchJson<{ conflicts: Array<{ connectionId: string; field: string; valuesByActor: Record<string, unknown> }> }>("/api/ai-connections/conflicts"),
      fetchJson<{ channels: Array<{ channelId: string; title: string; isActive: boolean }> }>("/api/channel-connections"),
    ]);
    const [settingsRes, statusRes, aiRes, channelsRes] = settled;
    if (settingsRes.status === "fulfilled") setSettings(settingsRes.value.conflicts ?? []);
    // RunPod not set up on this device: Production has no settings to compare -- not an error worth showing.
    if (statusRes.status === "fulfilled") setDivergence((statusRes.value.notices ?? []).some((n) => n.kind === "divergence" && n.snapshotId));
    else errors.push(statusRes.reason instanceof Error ? statusRes.reason.message : "device sync status unavailable");
    const next: ActorConflict[] = [];
    if (aiRes.status === "fulfilled") {
      for (const c of aiRes.value.conflicts) {
        next.push({ family: "ai_connections", key: `ai.${c.connectionId}.${c.field}`, group: "AI connections", subject: `Connection ${c.connectionId.slice(0, 8)}`, field: c.field, connectionId: c.connectionId, valuesByActor: c.valuesByActor, resolvable: true });
      }
    } else errors.push(aiRes.reason instanceof Error ? aiRes.reason.message : "AI-connection conflicts unavailable");
    if (channelsRes.status === "fulfilled") {
      // The active channel's drafts and profile only: the server answers these for the session's active channel and refuses any
      // other (ADR 0004); another channel's conflicts appear here once it is the active one (independent review).
      const perChannel = await Promise.allSettled(
        channelsRes.value.channels.filter((ch) => ch.isActive).map(async (ch) => {
          const [drafts, profile] = await Promise.all([
            fetchJson<{ conflicts: Array<{ changeId: string; field: string; valuesByActor: Record<string, unknown> }> }>(`/api/channels/${ch.channelId}/change-drafts/conflicts`),
            fetchJson<{ conflicts: Array<{ field: string; valuesByActor: Record<string, unknown> }> }>(`/api/channels/${ch.channelId}/editorial-profile/conflicts`),
          ]);
          return { ch, drafts: drafts.conflicts, profile: profile.conflicts };
        })
      );
      for (const r of perChannel) {
        if (r.status === "rejected") {
          errors.push(r.reason instanceof Error ? r.reason.message : "channel conflicts unavailable");
          continue;
        }
        const { ch, drafts, profile } = r.value;
        for (const c of drafts) {
          next.push({ family: "change_drafts", key: `drafts.${ch.channelId}.${c.changeId}.${c.field}`, group: `Change drafts — ${ch.title}`, subject: `Change ${c.changeId.slice(0, 8)}`, field: c.field, channelId: ch.channelId, changeId: c.changeId, valuesByActor: c.valuesByActor, resolvable: RESOLVABLE_CHANGE_DRAFT_FIELDS.has(c.field) });
        }
        for (const c of profile) {
          next.push({ family: "editorial_profile", key: `profile.${ch.channelId}.${c.field}`, group: `Channel profile — ${ch.title}`, subject: "Editorial profile", field: c.field, channelId: ch.channelId, valuesByActor: c.valuesByActor, resolvable: true });
        }
      }
    } else errors.push(channelsRes.reason instanceof Error ? channelsRes.reason.message : "channel list unavailable");
    setOthers(next);
    setError(errors.length > 0 ? errors.join(" ") : null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    queueMicrotask(() => void refresh());
  }, [enabled, refresh]);

  // Only what can be decided counts (and blocks the startup window): a draft field that cannot be resolved here never traps it.
  return { loaded, settings, others, divergence, error, total: settings.length + others.filter((c) => c.resolvable).length + (divergence ? 1 : 0), refresh };
}

function Tokens({ tokens, list }: { tokens: DiffToken[]; list?: boolean }) {
  if (list) {
    if (tokens.length === 0) return <p className="text-zinc-400">none</p>;
    return (
      <ol className="list-decimal space-y-0.5 pl-5">
        {tokens.map((t, i) => (
          <li key={i} className={t.changed ? "rounded bg-amber-500/20 px-1 text-amber-100" : "text-zinc-200"}>
            {t.text}
          </li>
        ))}
      </ol>
    );
  }
  return (
    <p className="whitespace-pre-wrap text-zinc-200">
      {tokens.map((t, i) => (
        <span key={i} className={t.changed ? "rounded bg-amber-500/20 text-amber-100" : undefined}>
          {t.text}
        </span>
      ))}
    </p>
  );
}

/** Two versions side by side, the differences highlighted; a "Keep this" under each. */
function VersionPair({
  leftTitle,
  rightTitle,
  left,
  right,
  unit,
  onKeep,
  busy,
  resolvable = true,
}: {
  leftTitle: string;
  rightTitle: string;
  left: unknown;
  right: unknown;
  unit?: (typeof SETTING_LABELS)[string]["unit"];
  onKeep: (side: "left" | "right") => void;
  busy: boolean;
  resolvable?: boolean;
}) {
  const bothLists = Array.isArray(left) && Array.isArray(right);
  const bothTexts = typeof left === "string" && typeof right === "string" && (left.length > 24 || right.length > 24);
  const diff = bothLists ? listDiff((left as unknown[]).map(String), (right as unknown[]).map(String)) : bothTexts ? wordDiff(left as string, right as string) : null;
  const column = (title: string, value: unknown, tokens: DiffToken[] | undefined, side: "left" | "right") => (
    <div className="flex flex-col rounded-lg border border-zinc-700 bg-zinc-950/60 p-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</p>
      <div className="flex-1 text-sm">{tokens ? <Tokens tokens={tokens} list={bothLists} /> : <p className="text-base font-semibold text-zinc-100">{formatValue(value, unit)}</p>}</div>
      {resolvable && (
        <button type="button" disabled={busy} onClick={() => onKeep(side)} className="mt-3 self-start rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          Keep this
        </button>
      )}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {column(leftTitle, left, diff?.left, "left")}
      {column(rightTitle, right, diff?.right, "right")}
    </div>
  );
}

export function ConflictCenter({
  state,
  blocking = false,
  hideDivergence = false,
  onDecideLater,
}: {
  state: ConflictCenterState;
  blocking?: boolean;
  hideDivergence?: boolean;
  /** Blocking window only: offered when a choice could not be saved (recovery mode, an import holding the lock, an endpoint
   * failing) -- the window must never trap the owner (independent review). */
  onDecideLater?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function act(run: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
      await state.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not keep that version");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const post = (url: string, body: unknown) => fetchJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const keepSetting = (c: SettingConflict, value: unknown) => act(() => post("/api/media-generation/settings-sync/resolve", { field: c.field, value }));
  const keepActor = (c: ActorConflict, actor: string) =>
    act(() =>
      c.family === "change_drafts"
        ? post(`/api/channels/${c.channelId}/change-drafts/conflicts`, { changeId: c.changeId, field: c.field, winningActorId: actor })
        : c.family === "editorial_profile"
          ? post(`/api/channels/${c.channelId}/editorial-profile/conflicts`, { field: c.field, winningActorId: actor })
          : post("/api/ai-connections/conflicts", { connectionId: c.connectionId, field: c.field, winningActorId: actor })
    );

  const groups = new Map<string, ActorConflict[]>();
  for (const c of state.others) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Your two computers differ — choose what to keep</h2>
        <p className="mt-1 text-sm text-zinc-400">
          {state.total === 0 ? "Nothing left to decide." : `Left to decide: ${state.total}.`} Each choice goes to both computers at once.
          {blocking && " The app opens once everything is decided; the server, syncing and the operator keep working meanwhile."}
        </p>
      </div>
      {(error || state.error) && <p className="text-sm text-red-400">{error ?? state.error}</p>}
      {blocking && onDecideLater && error && (
        <button type="button" onClick={onDecideLater} className="text-xs text-zinc-400 underline hover:text-zinc-200">
          Decide later — the differences stay listed in Merge
        </button>
      )}

      {state.settings.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200">Production settings</h3>
          {state.settings.map((c) => {
            // Normally one of the two values is this computer's own (it keeps it until the choice); if not, both are shown as versions.
            const mine = c.values.find((v) => JSON.stringify(v) === JSON.stringify(c.thisComputer));
            const [left, right] = mine !== undefined ? [mine, c.values.find((v) => v !== mine) ?? c.values[1]] : [c.values[0], c.values[1]];
            return (
              <div key={c.field} className="space-y-2 rounded-xl border border-amber-800/60 bg-amber-950/10 p-3">
                <p className="text-sm font-medium text-zinc-100">{settingLabel(c.field)}</p>
                <VersionPair
                  leftTitle={mine !== undefined ? "This computer" : "Version 1"}
                  rightTitle={mine !== undefined ? "The other computer" : "Version 2"}
                  left={left}
                  right={right}
                  unit={SETTING_LABELS[c.field]?.unit}
                  busy={busy}
                  onKeep={(side) => void keepSetting(c, side === "left" ? left : right)}
                />
              </div>
            );
          })}
        </section>
      )}

      {state.divergence && !hideDivergence && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-200">Batches, audit, Research and Decisions</h3>
          <DeviceSyncDivergenceCard />
        </section>
      )}

      {[...groups.entries()].map(([group, conflicts]) => (
        <section key={group} className="space-y-3">
          <h3 className="text-sm font-semibold text-zinc-200">{group}</h3>
          {conflicts.map((c) => {
            const versions = Object.entries(c.valuesByActor);
            const [a, b] = versions;
            return (
              <div key={c.key} className="space-y-2 rounded-xl border border-amber-800/60 bg-amber-950/10 p-3">
                <p className="text-sm font-medium text-zinc-100">
                  {c.subject} · {FIELD_LABELS[c.field] ?? c.field}
                </p>
                {a && b && versions.length === 2 ? (
                  <VersionPair leftTitle="Version 1" rightTitle="Version 2" left={a[1]} right={b[1]} busy={busy} resolvable={c.resolvable} onKeep={(side) => void keepActor(c, side === "left" ? a[0] : b[0])} />
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {versions.map(([actor, value], i) => (
                      <div key={actor} className="rounded-lg border border-zinc-700 bg-zinc-950/60 p-3 text-sm">
                        <p className="mb-1 text-[11px] uppercase text-zinc-500">Version {i + 1}</p>
                        <p className="whitespace-pre-wrap text-zinc-200">{formatValue(value)}</p>
                        {c.resolvable && (
                          <button type="button" disabled={busy} onClick={() => void keepActor(c, actor)} className="mt-3 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
                            Keep this
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {!c.resolvable && <p className="text-xs text-zinc-500">This field cannot be decided here; it settles with the next edit of the change.</p>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
