import type { ComfyProgressEvent } from "@/lib/media-gateway";

/**
 * BL-144 (owner, Telegram 2026-10-06, msgs 1885/1887: "real information, not estimates"): a running job's live progress,
 * built only from ComfyUI's own execution events (media-gateway/comfyui-progress.ts) -- never estimated from past
 * durations. Kept in memory on the device that runs the job, for as long as its generation is being watched; the job
 * row and its status transitions are untouched, so a missing or broken stream never affects the job itself (§M).
 */
export type JobLiveProgress = {
  /** `connecting` before the socket is open; `waiting` = ComfyUI has not started this prompt yet (queued behind another). */
  state: "connecting" | "waiting" | "running" | "finished" | "error" | "interrupted" | "unavailable";
  /** Nodes in the job's workflow graph; `null` when the graph is unknown. */
  nodesTotal: number | null;
  /** Nodes executed or served from ComfyUI's cache so far. */
  nodesDone: number;
  nodesCached: number;
  currentNode: { id: string; type: string | null } | null;
  /** The current node's own steps (e.g. sampler steps), when ComfyUI reports them. */
  step: { value: number; max: number } | null;
  /** Done nodes plus the current node's step fraction, over the graph's nodes; `null` without a graph. 100 only on success. */
  percent: number | null;
  startedAt: string | null;
  updatedAt: string;
  /** Why progress is unavailable, or ComfyUI's error text. */
  detail: string | null;
};

type Internal = {
  promptId: string | null;
  graph: Map<string, string | null>;
  done: Set<string>;
  cached: Set<string>;
  progress: JobLiveProgress;
};

/** `{ "3": { "class_type": "KSampler", ... }, ... }` (ComfyUI API-format workflow) → node id → class type. */
export function workflowNodeTypes(workflowJson: string | null): Map<string, string | null> {
  const graph = new Map<string, string | null>();
  if (!workflowJson) return graph;
  try {
    const parsed = JSON.parse(workflowJson) as Record<string, unknown>;
    for (const [id, node] of Object.entries(parsed ?? {})) {
      const type = node && typeof node === "object" && typeof (node as { class_type?: unknown }).class_type === "string" ? (node as { class_type: string }).class_type : null;
      graph.set(id, type);
    }
  } catch {
    // An unreadable graph only costs the node count and names.
  }
  return graph;
}

function recompute(s: Internal, at: Date): void {
  const p = s.progress;
  p.nodesDone = new Set([...s.done, ...s.cached]).size;
  p.nodesCached = s.cached.size;
  p.nodesTotal = s.graph.size > 0 ? s.graph.size : null;
  if (p.state === "finished") p.percent = 100;
  else if (p.nodesTotal) {
    const fraction = p.step && p.step.max > 0 ? Math.min(1, p.step.value / p.step.max) : 0;
    p.percent = Math.min(99, Math.floor(((Math.min(p.nodesDone, p.nodesTotal) + fraction) / p.nodesTotal) * 100));
  } else p.percent = null;
  p.updatedAt = at.toISOString();
}

/** Applies one ComfyUI event to a job's progress. Events of other prompts are ignored once the job's prompt is known. */
export function applyProgressEvent(s: Internal, event: ComfyProgressEvent, at: Date): void {
  // The socket is per job (clientId ytm-<jobId>), so this is only a safety net; ComfyUI's on-connect re-send of the
  // current node carries no prompt id and is accepted.
  if (s.promptId && event.promptId && event.promptId !== s.promptId) return;
  const p = s.progress;
  const node = (id: string) => ({ id, type: s.graph.get(id) ?? null });
  switch (event.type) {
    case "execution_start":
      p.state = "running";
      p.startedAt ??= at.toISOString();
      break;
    case "execution_cached":
      for (const id of event.nodeIds) s.cached.add(id);
      if (p.state === "waiting" || p.state === "connecting") p.state = "running";
      break;
    case "executing":
      if (event.nodeId === null) {
        // Legacy "prompt finished"; success/error/interrupted arrive as their own messages on current builds.
        if (p.currentNode) s.done.add(p.currentNode.id);
        p.currentNode = null;
        p.step = null;
        break;
      }
      if (p.currentNode && p.currentNode.id !== event.nodeId) s.done.add(p.currentNode.id);
      p.state = "running";
      p.startedAt ??= at.toISOString();
      p.currentNode = node(event.nodeId);
      p.step = null;
      break;
    case "progress":
      p.state = "running";
      p.startedAt ??= at.toISOString();
      if (event.nodeId && (!p.currentNode || p.currentNode.id !== event.nodeId)) {
        // A step report for another node means the previous one has finished (its `executing` may have been missed).
        if (p.currentNode) s.done.add(p.currentNode.id);
        p.currentNode = node(event.nodeId);
      }
      p.step = { value: event.value, max: event.max };
      break;
    case "executed":
      s.done.add(event.nodeId);
      if (p.currentNode?.id === event.nodeId) {
        // Finished: no longer "current", so it is not counted twice (done + current).
        p.currentNode = null;
        p.step = null;
      }
      break;
    case "progress_state": {
      for (const n of event.nodes) if (n.state === "finished") s.done.add(n.nodeId);
      const running = event.nodes.find((n) => n.state === "running");
      if (running) {
        p.state = "running";
        p.currentNode = node(running.nodeId);
        p.step = running.max > 1 ? { value: running.value, max: running.max } : null;
      }
      break;
    }
    case "execution_success":
      p.state = "finished";
      p.currentNode = null;
      p.step = null;
      break;
    case "execution_error":
      p.state = "error";
      p.detail = [event.message, event.nodeType ? `node ${event.nodeType}${event.nodeId ? ` #${event.nodeId}` : ""}` : null].filter(Boolean).join(" · ") || null;
      break;
    case "execution_interrupted":
      p.state = "interrupted";
      p.step = null;
      break;
  }
  recompute(s, at);
}

/** In-memory live progress per job on this device. One instance per process (see index.ts). */
export function createJobProgressRegistry() {
  const jobs = new Map<string, Internal>();
  return {
    /** Starts watching a job: `connecting`, with the graph's node count when known. */
    begin(jobId: string, input: { promptId: string | null; workflowJson: string | null }, at: Date): void {
      const s: Internal = {
        promptId: input.promptId,
        graph: workflowNodeTypes(input.workflowJson),
        done: new Set(),
        cached: new Set(),
        progress: { state: "connecting", nodesTotal: null, nodesDone: 0, nodesCached: 0, currentNode: null, step: null, percent: null, startedAt: null, updatedAt: at.toISOString(), detail: null },
      };
      recompute(s, at);
      jobs.set(jobId, s);
    },
    /**
     * The socket is open. A first connection waits for ComfyUI to start the prompt; a reconnection of a job that was
     * already running stays running (ComfyUI re-sends its current node on connect).
     */
    connected(jobId: string, at: Date): void {
      const s = jobs.get(jobId);
      if (!s || s.progress.state !== "connecting") return;
      s.progress.state = s.progress.startedAt ? "running" : "waiting";
      recompute(s, at);
    },
    /** The prompt id ComfyUI assigned (known only after the submit, which happens with the socket already open). */
    setPrompt(jobId: string, promptId: string): void {
      const s = jobs.get(jobId);
      if (s) s.promptId = promptId;
    },
    /** A dropped stream is being reopened. */
    reconnecting(jobId: string, at: Date): void {
      const s = jobs.get(jobId);
      if (!s || s.progress.state !== "unavailable") return;
      s.progress.state = "connecting";
      s.progress.detail = null;
      recompute(s, at);
    },
    has(jobId: string): boolean {
      return jobs.has(jobId);
    },
    apply(jobId: string, event: ComfyProgressEvent, at: Date): void {
      const s = jobs.get(jobId);
      if (s) applyProgressEvent(s, event, at);
    },
    /** The stream could not be opened or dropped before the job ended: the job goes on, its progress is not shown. */
    unavailable(jobId: string, reason: string, at: Date): void {
      const s = jobs.get(jobId);
      if (!s || s.progress.state === "finished" || s.progress.state === "error" || s.progress.state === "interrupted") return;
      s.progress.state = "unavailable";
      s.progress.detail = reason;
      recompute(s, at);
    },
    get(jobId: string): JobLiveProgress | null {
      const s = jobs.get(jobId);
      return s ? { ...s.progress, currentNode: s.progress.currentNode ? { ...s.progress.currentNode } : null, step: s.progress.step ? { ...s.progress.step } : null } : null;
    },
    end(jobId: string): void {
      jobs.delete(jobId);
    },
  };
}

export type JobProgressRegistry = ReturnType<typeof createJobProgressRegistry>;
