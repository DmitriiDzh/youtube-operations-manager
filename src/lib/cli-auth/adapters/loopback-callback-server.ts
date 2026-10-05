import { createServer } from "node:http";
import { authCallbackInvalid } from "../contracts";

export type LoopbackCallbackResult = {
  code: string;
  state: string;
};

export function createLoopbackCallbackServer(args: {
  expectedState: string;
  timeoutMs: number;
}): Promise<{ redirectUri: string; waitForCallback: Promise<LoopbackCallbackResult> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const loopbackPort = Number(process.env.CLI_OAUTH_CALLBACK_PORT ?? "8787");

    const waitForCallback = new Promise<LoopbackCallbackResult>((innerResolve, innerReject) => {
      const timeout = setTimeout(() => {
        server.close();
        innerReject(
          authCallbackInvalid("OAuth callback timeout. Retry with `auth login`.", {
            reason: "timeout",
          })
        );
      }, args.timeoutMs);

      server.on("request", (req, res) => {
        try {
          const callbackUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          const state = callbackUrl.searchParams.get("state");
          const code = callbackUrl.searchParams.get("code");
          const error = callbackUrl.searchParams.get("error");

          if (error) {
            res.statusCode = 400;
            res.end("Authorization failed. You can close this tab.");
            clearTimeout(timeout);
            server.close();
            innerReject(
              authCallbackInvalid("OAuth callback returned an error", {
                reason: error,
              })
            );
            return;
          }

          if (!code || !state || state !== args.expectedState) {
            res.statusCode = 400;
            res.end("Invalid callback payload. You can close this tab.");
            clearTimeout(timeout);
            server.close();
            innerReject(
              authCallbackInvalid("OAuth callback state validation failed", {
                reason: "invalid_state_or_code",
              })
            );
            return;
          }

          res.statusCode = 200;
          res.end("Authorization complete. You can close this tab.");
          clearTimeout(timeout);
          server.close();
          innerResolve({ code, state });
        } catch {
          clearTimeout(timeout);
          server.close();
          innerReject(authCallbackInvalid("Failed to process OAuth callback", { reason: "parse_error" }));
        }
      });
    });

    server.listen(loopbackPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(authCallbackInvalid("Could not bind loopback callback server"));
        return;
      }

      resolve({
        redirectUri: `http://127.0.0.1:${address.port}`,
        waitForCallback,
      });
    });

    server.on("error", (error) => {
      reject(
        authCallbackInvalid("Loopback callback server failed", {
          reason: error.message,
          port: loopbackPort,
        })
      );
    });
  });
}
