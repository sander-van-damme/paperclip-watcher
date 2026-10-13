import { spawn } from "node:child_process";

export type QuotaAvailability = "available" | "exhausted" | "unknown";
export interface QuotaSnapshot {
  availability: QuotaAvailability;
  accountId: string | null;
  reason: string;
}
type JsonObject = Record<string, unknown>;
const record = (v: unknown): JsonObject | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : null;

/**
 * The Codex app-server is the authority for this *local user's* included usage.
 * No model turn, credit redemption, or upstream token scraping is involved.
 * Unknown or incomplete responses must never be interpreted as a quota reset.
 */
export function interpretCodexQuota(response: unknown, expectedAccountId?: string): QuotaSnapshot {
  const data = record(response);
  const unknown = (reason: string): QuotaSnapshot => ({ availability: "unknown", accountId: null, reason });
  if (!data) return unknown("malformed_response");
  const accountId = typeof data.accountId === "string" && data.accountId ? data.accountId : null;
  if (expectedAccountId && accountId !== expectedAccountId) return unknown("account_mismatch");
  const buckets = record(data.rateLimitsByLimitId);
  const bucket = (buckets && buckets.codex !== undefined)
    ? record(buckets.codex) : record(data.rateLimits);
  if (!bucket) return unknown("missing_codex_bucket");
  if (data.ordinaryUsageAllowed === false || bucket.spendControlReached === true ||
      (typeof bucket.rateLimitReachedType === "string" && bucket.rateLimitReachedType.length > 0)) {
    return { availability: "exhausted", accountId, reason: "backend_denied_usage" };
  }
  const windows = [bucket.primary, bucket.secondary]
    .filter(v => v !== undefined && v !== null);
  if (windows.length === 0) return unknown("no_usage_windows");
  let exhausted = false;
  for (const item of windows) {
    const v = record(item);
    if (!v || typeof v.usedPercent !== "number" || !Number.isFinite(v.usedPercent) ||
        v.usedPercent < 0 || v.usedPercent > 100) return unknown("invalid_usage_window");
    if (v.usedPercent >= 100) exhausted = true;
  }
  if (exhausted) return { availability: "exhausted", accountId, reason: "window_exhausted" };
  if (data.ordinaryUsageAllowed !== true) return unknown("backend_permission_unknown");
  return { availability: "available", accountId, reason: "backend_allows_usage" };
}

/** One bounded stdio JSON-RPC session per poll. Codex is not asked to run any model. */
export function readLocalCodexQuota(
  executable = "codex",
  expectedAccountId?: string,
  timeoutMs = 15_000,
): Promise<QuotaSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    });
    let complete = false;
    let stdout = "";
    const settle = (error?: Error, value?: QuotaSnapshot) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => settle(new Error("Codex app-server rate limit probe timed out")), timeoutMs);
    child.on("error", error => settle(new Error("Codex quota probe could not start: " + ("code" in error ? String(error.code) : "unknown"))));
    child.on("close", code => {
      if (!complete) settle(new Error("Codex quota probe ended before response: " + code));
    });
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > 256_000) return settle(new Error("Codex quota response too large"));
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        const value = record(message);
        if (!value || value.id !== 2) continue;
        if (value.error) return settle(new Error("Codex rate limit RPC returned an error"));
        return settle(undefined, interpretCodexQuota(value.result, expectedAccountId));
      }
    });
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        clientInfo: { name: "paperclip_watcher", title: "Paperclip Watcher", version: "1.0.0" },
      }},
      { jsonrpc: "2.0", method: "initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} },
    ];
    child.stdin.on("error", () => {}); // A fast-exiting child must not crash the watcher.
    child.stdin.end(reqs.map(v => JSON.stringify(v)).join("\n") + "\n");
  });
}
