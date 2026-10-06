import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { startExportHttpServer } from "./export-http.js";
import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import { PaperclipWatcher } from "./watcher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new PaperclipClient(config);
  const watcher = new PaperclipWatcher(config, client);
  let running = true;
  let exportServer: Server | null = null;

  const exportHttpEnabled =
    (process.env.PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
  if (exportHttpEnabled) {
    try {
      exportServer = await startExportHttpServer();
    } catch (error) {
      log("error", "Support export UI failed to start; watcher will continue", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const stop = (signal: string) => {
    if (!running) return;
    running = false;
    log("info", "Shutdown requested", { signal });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log("info", "Paperclip watcher started", {
    apiUrl: config.apiUrl,
    ceoAgentId: config.ceoAgentId,
    configuredCompanyId: config.companyId ?? null,
    pollIntervalMs: config.pollIntervalMs,
    dryRun: config.dryRun,
    exportHttpEnabled,
  });

  let consecutiveFailures = 0;
  try {
    while (running) {
      try {
        const result = await watcher.pollOnce();
        consecutiveFailures = 0;
        if (result.candidates > 0 || result.escalated > 0) {
          log("info", "Poll completed", result);
        }
      } catch (error) {
        consecutiveFailures += 1;
        log("error", "Poll failed", {
          error: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
        });
      }

      if (!running) break;
      const backoffMultiplier = Math.min(4, Math.max(1, consecutiveFailures + 1));
      await sleep(Math.min(60_000, config.pollIntervalMs * backoffMultiplier));
    }
  } finally {
    await closeServer(exportServer);
  }

  log("info", "Paperclip watcher stopped");
}

main().catch((error) => {
  log("error", "Fatal watcher error", {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
