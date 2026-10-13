import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { TaskWatchdogCoverageSupervisor } from "./task-watchdog-coverage.js";
import { FileTaskWatchdogCoverageStore } from "./task-watchdog-state.js";
import { startExportHttpServer } from "./export-http.js";
import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import { HumanInputNotifier } from "./human-input-notifier.js";
import { readLocalCodexQuota } from "./codex-quota.js";
import { CodexQuotaMonitor } from "./codex-quota-monitor.js";
import type { QuotaReport } from "./codex-quota-monitor.js";
import { FileStateStore } from "./state.js";
import { PaperclipWatcher } from "./watcher.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new PaperclipClient(config);
  const notifier = config.pushover ? new HumanInputNotifier(client, config.stateDir, config.pushover) : null;
  const companyId = notifier ? (config.companyId ?? (await client.getAgent(config.ctoAgentId)).companyId) : null;
  const watcher = new PaperclipWatcher(config, client, new FileStateStore(config.stateDir));
  const quotaMonitor = config.codexQuota ? new CodexQuotaMonitor(config.stateDir, () =>
    readLocalCodexQuota(config.codexQuota!.executable, config.codexQuota!.expectedAccountId),
  ) : null;
  const taskWatchdogs = new TaskWatchdogCoverageSupervisor(
    config, client, new FileTaskWatchdogCoverageStore(config.stateDir),
  );
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
  log("info", "Paperclip CTO watcher started", {
    pollIntervalMs: config.pollIntervalMs,
    dryRun: config.dryRun,
    taskWatchdogScanIntervalMs: config.taskWatchdogScanIntervalMs,
  });
  let failures = 0;
  let lastReport: string | null = null;
  let lastTaskWatchdogReport: string | null = null;
  let nextTaskWatchdogScanAt = 0;
  let nextNotificationScanAt = 0;
  let nextQuotaScanAt = 0;
  let quotaReport: QuotaReport | undefined;
  let lastQuotaReport: string | null = null;
  try {
    while (running) {
      if (running && quotaMonitor && config.codexQuota && Date.now() >= nextQuotaScanAt) {
        nextQuotaScanAt = Date.now() + config.codexQuota.intervalMs;
        try {
          quotaReport = await quotaMonitor.poll();
          const report = JSON.stringify(quotaReport);
          if (report !== lastQuotaReport) {
            log("info", "Local Codex quota", { ...quotaReport });
            lastQuotaReport = report;
          }
        } catch (error) {
          quotaReport = { availability: "unknown", recoveryEpoch: 0, reason: "state_error" };
          log("error", "Codex quota monitor state failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        const result = await watcher.pollOnce(quotaReport);
        failures = 0;
        // Log transitions, including reasons that suppress a wake, but avoid
        // flooding the journal every 15 seconds when nothing has changed.
        const report = JSON.stringify(result);
        if (report !== lastReport || result.state === "woken") {
          log("info", "CTO state", { ...result });
          lastReport = report;
        }
      } catch (error) {
        failures++;
        log("error", "Watcher poll failed", { error: error instanceof Error ? error.message : String(error) });
      }
      if (running && Date.now() >= nextTaskWatchdogScanAt) {
        nextTaskWatchdogScanAt = Date.now() + config.taskWatchdogScanIntervalMs;
        try {
          const result = await taskWatchdogs.pollOnce();
          const report = JSON.stringify(result);
          if (report !== lastTaskWatchdogReport || result.attached > 0 || result.dryRunCandidates > 0) {
            log("info", "CTO task watchdog coverage", { ...result });
            lastTaskWatchdogReport = report;
          }
        } catch (error) {
          log("error", "CTO task watchdog scan failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (running && notifier && companyId && Date.now() >= nextNotificationScanAt) {
        nextNotificationScanAt = Date.now() + 60_000;
        try {
          const count = await notifier.poll(companyId, config.ctoAgentId);
          if (count > 0) log("info", "Pushover human-input notifications", { sent: count });
        } catch (error) {
          log("error", "Pushover human-input scan failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (running) await sleep(Math.min(60_000, config.pollIntervalMs * Math.min(4, failures + 1)));
    }
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
