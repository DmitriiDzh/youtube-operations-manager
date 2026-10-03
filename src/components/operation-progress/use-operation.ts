"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  IDLE_OPERATION,
  isOperationActive,
  operationReducer,
  type OperationItem,
  type OperationItemStatus,
  type QuotaServiceKey,
  type ServerOperationSnapshot,
} from "./operation-state";

const QUOTA_POLL_MS = 10_000;
const SERVER_POLL_MS = 1_000;

/** What `attach` hands to `onFinished`: the final server snapshot. */
export type AttachedOperationResult = ServerOperationSnapshot & { id: string };

/**
 * React binding for `operation-state.ts`. The cancel flag lives in a ref, not only in state: the
 * running `async` loop that checks `isCancelRequested()` captured an old render's closure, so a
 * state value read there would never flip. Cancel is cooperative -- a loop checks it BEFORE each
 * item and never aborts an in-flight request (a YouTube write already sent cannot be recalled,
 * and aborting the fetch would only lose its result).
 */
export function useOperation() {
  const [state, dispatch] = useReducer(operationReducer, IDLE_OPERATION);
  const cancelRef = useRef(false);
  const active = isOperationActive(state);
  const quotaServicesRef = useRef<QuotaServiceKey[]>([]);
  // A server-run operation being followed (survives a page reload: the caller re-attaches by id).
  const [attached, setAttached] = useState<{ id: string; onFinished?: (result: AttachedOperationResult) => void } | null>(null);

  const pollQuota = useCallback(async () => {
    if (quotaServicesRef.current.length === 0) return;
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const status = (await res.json()).cloudQuotaStatus as
        | { dataApi?: { limit: number; usedLast24h: number } | null; analytics?: { limit: number; usedLast24h: number } | null }
        | null
        | undefined;
      for (const service of quotaServicesRef.current) {
        const reading = status?.[service];
        // null = Cloud not connected / query failed: show nothing rather than an invented number.
        if (reading) dispatch({ type: "quota", service, used: reading.usedLast24h, limit: reading.limit });
      }
    } catch {
      // Quota display is informational; a failed poll never affects the operation.
    }
  }, []);

  // Live quota while the operation runs (owner request 2026-10-03), plus one last reading at the end.
  useEffect(() => {
    if (!active || quotaServicesRef.current.length === 0) return;
    void pollQuota();
    const id = setInterval(() => void pollQuota(), QUOTA_POLL_MS);
    return () => clearInterval(id);
  }, [active, pollQuota]);

  // Follow a server-run operation: mirror its registry snapshot until it ends or disappears.
  useEffect(() => {
    if (!attached) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/operations/${encodeURIComponent(attached.id)}`);
        if (stopped) return;
        if (res.status === 404) {
          dispatch({ type: "finish", error: true, message: "The operation is no longer available (the server may have restarted).", now: Date.now() });
          setAttached(null);
          return;
        }
        if (!res.ok) return;
        const snapshot = (await res.json()) as ServerOperationSnapshot;
        if (stopped) return;
        dispatch({ type: "sync", snapshot });
        if (snapshot.status !== "running" && snapshot.status !== "cancelling") {
          setAttached(null);
          void pollQuota();
          attached.onFinished?.({ ...snapshot, id: attached.id });
        }
      } catch {
        // A missed poll only delays the display; the server keeps working.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), SERVER_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [attached, pollQuota]);

  // A browser-driven loop dies with the page: warn before a reload/close mid-run. A server-run
  // operation keeps going without the page, so it needs no warning.
  useEffect(() => {
    if (!active || attached) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active, attached]);

  const start = useCallback(
    (options: { title: string; items?: OperationItem[]; total?: number; cancellable?: boolean; quotaServices?: QuotaServiceKey[] }) => {
      cancelRef.current = false;
      setAttached(null);
      const { quotaServices = [], ...rest } = options;
      quotaServicesRef.current = quotaServices;
      dispatch({ type: "start", ...rest, now: Date.now() });
    },
    []
  );
  const setStage = useCallback((stage: string | null) => dispatch({ type: "stage", stage }), []);
  const setItem = useCallback(
    (id: string, status: OperationItemStatus, detail?: string) => dispatch({ type: "item", id, status, detail }),
    []
  );
  const setItems = useCallback((items: OperationItem[]) => dispatch({ type: "setItems", items }), []);
  const setCounts = useCallback((done: number, total: number) => dispatch({ type: "counts", done, total }), []);
  const requestCancel = useCallback(() => {
    cancelRef.current = true;
    dispatch({ type: "requestCancel" });
    if (attached) void fetch(`/api/operations/${encodeURIComponent(attached.id)}/cancel`, { method: "POST" }).catch(() => undefined);
  }, [attached]);
  /** Follows an operation the SERVER is running (survives a reload -- call it again with the same id
   * from a freshly loaded page). Cancel then goes to the server's registry. */
  const attach = useCallback(
    (operationId: string, options: { title: string; quotaServices?: QuotaServiceKey[]; onFinished?: (result: AttachedOperationResult) => void }) => {
      cancelRef.current = false;
      quotaServicesRef.current = options.quotaServices ?? [];
      dispatch({ type: "start", title: options.title, cancellable: true, now: Date.now() });
      setAttached({ id: operationId, onFinished: options.onFinished });
    },
    []
  );
  const isCancelRequested = useCallback(() => cancelRef.current, []);
  const finish = useCallback(
    (result: { message?: string | null; error?: boolean; outcome?: "success" | "cancelled" } = {}) => {
      dispatch({ type: "finish", ...result, now: Date.now() });
      void pollQuota();
    },
    [pollQuota]
  );
  const reset = useCallback(() => {
    setAttached(null);
    dispatch({ type: "reset" });
  }, []);

  return { state, start, attach, setStage, setItem, setItems, setCounts, requestCancel, isCancelRequested, finish, reset };
}

export type OperationController = ReturnType<typeof useOperation>;
