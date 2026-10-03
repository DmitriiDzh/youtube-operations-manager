"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  IDLE_OPERATION,
  isOperationActive,
  operationReducer,
  type OperationItem,
  type OperationItemStatus,
  type QuotaServiceKey,
} from "./operation-state";

const QUOTA_POLL_MS = 10_000;

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

  // A client-driven loop dies with the page: warn before a reload/close mid-run.
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const start = useCallback(
    (options: { title: string; items?: OperationItem[]; total?: number; cancellable?: boolean; quotaServices?: QuotaServiceKey[] }) => {
      cancelRef.current = false;
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
  }, []);
  const isCancelRequested = useCallback(() => cancelRef.current, []);
  const finish = useCallback(
    (result: { message?: string | null; error?: boolean } = {}) => {
      dispatch({ type: "finish", ...result, now: Date.now() });
      void pollQuota();
    },
    [pollQuota]
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return { state, start, setStage, setItem, setItems, setCounts, requestCancel, isCancelRequested, finish, reset };
}

export type OperationController = ReturnType<typeof useOperation>;
