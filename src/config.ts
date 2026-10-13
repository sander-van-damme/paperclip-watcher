import { resolve } from "node:path";
import type { WatcherConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(): WatcherConfig {
  const apiUrl = required("PAPERCLIP_API_URL").replace(/\/+$/, "");
  if (apiUrl.endsWith("/api")) {
    throw new Error("PAPERCLIP_API_URL must be the server base URL without /api");
  }

  const pageSize = positiveInt("PAPERCLIP_WATCHER_PAGE_SIZE", 500);
  if (pageSize > 1000) throw new Error("PAPERCLIP_WATCHER_PAGE_SIZE must be <= 1000");

  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim() || undefined;
  const ceoAgentId = process.env.PAPERCLIP_CEO_AGENT_ID?.trim() || undefined;
  const pushToken = process.env.PAPERCLIP_WATCHER_PUSHOVER_TOKEN?.trim();
  const pushUser = process.env.PAPERCLIP_WATCHER_PUSHOVER_USER?.trim();
  const pushUrl = process.env.PAPERCLIP_WATCHER_PUSHOVER_PAPERCLIP_URL?.trim();
  const pushUserId = process.env.PAPERCLIP_WATCHER_PUSHOVER_USER_ID?.trim();
  if ([pushToken, pushUser, pushUrl].some(Boolean) && ![pushToken, pushUser, pushUrl].every(Boolean)) {
    throw new Error("Pushover requires TOKEN, USER, and PAPERCLIP_URL");
  }
  if (pushUrl) {
    const url = new URL(pushUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash) throw new Error("Invalid PAPERCLIP_WATCHER_PUSHOVER_PAPERCLIP_URL");
  }
  const taskWatchdogMaxAttachmentsPerPoll = positiveInt("PAPERCLIP_WATCHER_TASK_WATCHDOG_MAX_ATTACHMENTS_PER_POLL", 1);
  if (taskWatchdogMaxAttachmentsPerPoll > 20) {
    throw new Error("PAPERCLIP_WATCHER_TASK_WATCHDOG_MAX_ATTACHMENTS_PER_POLL must be <= 20");
  }
  const taskWatchdogInstructions = process.env.PAPERCLIP_WATCHER_TASK_WATCHDOG_INSTRUCTIONS?.trim() ||
    "Review stopped CTO work against the recorded evidence. Preserve legitimate failures, cancellations, " +
    "review waits, scheduled retries and rate limits. Investigate stale or cancelled dependencies; " +
    "repair only when authorized and evidence supports the change. Never mark unproven work done, " +
    "start duplicate engineering, bypass approvals or act outside the watched subtree. " +
    "If you cannot safely restore a live path, leave a specific owner and next action.";

  return {
    apiUrl,
    apiKey: required("PAPERCLIP_API_KEY"),
    ctoAgentId: required("PAPERCLIP_CTO_AGENT_ID"),
    ...(companyId ? { companyId } : {}),
    ...(ceoAgentId ? { ceoAgentId } : {}),
    taskWatchdogScanIntervalMs: positiveInt("PAPERCLIP_WATCHER_TASK_WATCHDOG_SCAN_INTERVAL_MS", 60_000),
    taskWatchdogMaxAttachmentsPerPoll,
    taskWatchdogInstructions,
    ...(pushToken && pushUser && pushUrl ? { pushover: {
      token: pushToken, user: pushUser, baseUrl: pushUrl.endsWith("/") ? pushUrl.slice(0, -1) : pushUrl,
      ...(pushUserId ? { userId: pushUserId } : {}),
    }} : {}),
    pollIntervalMs: positiveInt("PAPERCLIP_WATCHER_POLL_INTERVAL_MS", 15_000),
    requestTimeoutMs: positiveInt("PAPERCLIP_WATCHER_REQUEST_TIMEOUT_MS", 10_000),
    pageSize,
    idleGraceMs: positiveInt("PAPERCLIP_WATCHER_IDLE_GRACE_MS", 60000),
    cooldownMs: positiveInt("PAPERCLIP_WATCHER_COOLDOWN_MS", 300000),
    stateDir: resolve(process.env.PAPERCLIP_WATCHER_STATE_DIR?.trim() || process.env.STATE_DIRECTORY?.split(":")[0]?.trim() || ".paperclip-watcher-state"),
    dryRun: booleanEnv("PAPERCLIP_WATCHER_DRY_RUN"),
  };
}
