import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { startExportHttpServer } from "./export-http.js";
import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import { FileStateStore } from "./state.js";
import { PaperclipWatcher } from "./watcher.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function main(): Promise<void> {
  const config = loadConfig();
  const watcher = new PaperclipWatcher(config, new PaperclipClient(config), new FileStateStore(config.stateDir));
  let running = true;
  let server: Server | null = null;
  if ((process.env.PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED ?? "true").toLowerCase() !== "false") {
    // Security-sensitive: do not launch an unauthenticated export listener.
    if (!process.env.PAPERCLIP_WATCHER_EXPORT_PASSWORD) {
      throw new Error("Set PAPERCLIP_WATCHER_EXPORT_PASSWORD or disable export HTTP");
    }
    server = await startExportHttpServer();
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { running = false; });
  log("info", "Paperclip CTO watcher started", { pollIntervalMs: config.pollIntervalMs, dryRun: config.dryRun });
  let failures = 0;
  let lastState: string | null = null;
  try {
    while (running) {
      try {
        const result = await watcher.pollOnce();
        failures = 0;
        // Log transitions, including reasons that suppress a wake, but avoid
        // flooding the journal every 15 seconds when nothing has changed.
        if (result.state !== lastState || result.state === "woken") {
          log("info", "CTO state", result);
          lastState = result.state;
        }
      } catch (error) {
        failures++;
        log("error", "Watcher poll failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (running) await sleep(Math.min(60_000, config.pollIntervalMs * Math.min(4, failures + 1)));
    }
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
