export function createDefaultLogger() {
  return {
    info(payload: { event: string; context?: Record<string, unknown> }) {
      console.log(JSON.stringify({ level: "info", ...payload }));
    },
    error(payload: { event: string; context?: Record<string, unknown> }) {
      console.error(JSON.stringify({ level: "error", ...payload }));
    },
  };
}
