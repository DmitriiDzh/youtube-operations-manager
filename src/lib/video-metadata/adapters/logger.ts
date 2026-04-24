type LogLevel = "info" | "error";

type LogPayload = {
  event: string;
  context?: Record<string, unknown>;
};

export type VideoMetadataLogger = {
  info: (payload: LogPayload) => void;
  error: (payload: LogPayload) => void;
};

function log(level: LogLevel, payload: LogPayload) {
  const line = {
    level,
    event: payload.event,
    timestamp: new Date().toISOString(),
    ...(payload.context ? { context: payload.context } : {}),
  };

  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export function createDefaultLogger(): VideoMetadataLogger {
  return {
    info(payload) {
      log("info", payload);
    },
    error(payload) {
      log("error", payload);
    },
  };
}
