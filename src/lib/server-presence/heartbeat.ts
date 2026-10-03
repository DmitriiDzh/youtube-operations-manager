/** How often an open page tells the server it is still there (the server's idle window is 10 minutes). */
export const PRESENCE_PING_INTERVAL_MS = 60_000;
/** This many failed pings in a row mean the server is gone (one can be a blip). */
export const PRESENCE_FAILURES_BEFORE_STOPPED = 2;

export type PresenceState = { consecutiveFailures: number; serverStopped: boolean };
export const INITIAL_PRESENCE_STATE: PresenceState = { consecutiveFailures: 0, serverStopped: false };

/**
 * Pure state step for the heartbeat (BL-116): a success clears the failure count (and the "stopped" verdict, e.g. the
 * server was restarted); `PRESENCE_FAILURES_BEFORE_STOPPED` failures in a row declare the server stopped.
 */
export function nextPresenceState(state: PresenceState, pingOk: boolean): PresenceState {
  if (pingOk) return INITIAL_PRESENCE_STATE;
  const consecutiveFailures = state.consecutiveFailures + 1;
  return { consecutiveFailures, serverStopped: state.serverStopped || consecutiveFailures >= PRESENCE_FAILURES_BEFORE_STOPPED };
}
