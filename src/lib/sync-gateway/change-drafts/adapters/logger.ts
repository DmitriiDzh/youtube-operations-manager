export type ChangeDraftsLogger = {
  info(payload: { event: string; context?: Record<string, unknown> }): void;
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

export function createDefaultLogger(): ChangeDraftsLogger {
  return {
    info(payload) {
      console.log(JSON.stringify({ level: "info", ...payload }));
    },
    error(payload) {
      console.error(JSON.stringify({ level: "error", ...payload }));
    },
  };
}
