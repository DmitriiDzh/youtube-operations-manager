import { spawn } from "node:child_process";

export function defaultOpenBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], {
      stdio: "ignore",
      shell: process.platform === "win32",
      detached: true,
    });

    child.on("error", reject);
    child.unref();
    resolve();
  });
}
