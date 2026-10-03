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

  const pageSize = positiveInt("PAPERCLIP_WATCHER_PAGE_SIZE", 100);
  if (pageSize > 1000) throw new Error("PAPERCLIP_WATCHER_PAGE_SIZE must be <= 1000");

  const companyId = process.env.PAPERCLIP_COMPANY_ID?.trim() || undefined;

  return {
    apiUrl,
    apiKey: required("PAPERCLIP_API_KEY"),
    ceoAgentId: required("PAPERCLIP_CEO_AGENT_ID"),
    ...(companyId ? { companyId } : {}),
    pollIntervalMs: positiveInt("PAPERCLIP_WATCHER_POLL_INTERVAL_MS", 15_000),
    requestTimeoutMs: positiveInt("PAPERCLIP_WATCHER_REQUEST_TIMEOUT_MS", 10_000),
    pageSize,
    dryRun: booleanEnv("PAPERCLIP_WATCHER_DRY_RUN"),
  };
}
