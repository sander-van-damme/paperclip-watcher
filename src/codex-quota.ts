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
  const bucket = buckets ? record(buckets.codex) : record(data.rateLimits);
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

/** Safe, actionable failure classes; never expose raw Codex responses or credentials. */
export type CodexProbeFailureCode =
  | "binary_not_found" | "launch_failed" | "initialize_rejected"
  | "rate_limits_rejected" | "protocol_error" | "connection_closed"
  | "timeout" | "response_too_large";

export class CodexQuotaProbeError extends Error {
  constructor(readonly code: CodexProbeFailureCode) {
    super("Codex quota probe failed: " + code);
    this.name = "CodexQuotaProbeError";
  }
}

/**
 * One bounded read-only Codex App Server stdio JSON-RPC session per poll.
 *
 * The documented handshake is sequential: initialize request -> initialize
 * response -> initialized notification -> account/rateLimits/read request.
 * Keep stdin OPEN until the quota response, otherwise Codex can exit on EOF.
 * No model turn is requested, and stderr or RPC error data are never logged.
 */
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
    let finished = false;
    let initialized = false;
    let pendingOutput = "";
    const timer = setTimeout(() => fail("timeout"), timeoutMs);

    function finish(error?: CodexQuotaProbeError, result?: QuotaSnapshot): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Do not wait for child process shutdown to return the quota answer.
      child.kill();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new CodexQuotaProbeError("protocol_error"));
    }
    function fail(code: CodexProbeFailureCode): void {
      finish(new CodexQuotaProbeError(code));
    }
    function send(request: Record<string, unknown>): void {
      if (finished) return;
      try {
        child.stdin.write(JSON.stringify(request) + "\n", error => {
          if (error && !finished) fail("connection_closed");
        });
      } catch {
        fail("connection_closed");
      }
    }
    child.on("error", error => {
      fail(("code" in error && error.code === "ENOENT") ? "binary_not_found" : "launch_failed");
    });
    child.on("close", () => {
      if (!finished) fail("connection_closed");
    });
    child.stdin.on("error", () => {
      if (!finished) fail("connection_closed");
    });
    child.stdout.on("error", () => {
      if (!finished) fail("connection_closed");
    });
    child.stdout.on("data", (data: Buffer) => {
      if (finished) return;
      pendingOutput += data.toString("utf8");
      if (pendingOutput.length > 256_000) {
        fail("response_too_large");
        return;
      }
      let index: number;
      while (!finished && (index = pendingOutput.indexOf("\n")) !== -1) {
        const line = pendingOutput.slice(0, index).trim();
        pendingOutput = pendingOutput.slice(index + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          fail("protocol_error");
          break;
        }
        const response = record(parsed);
        if (!response) {
          fail("protocol_error");
          break;
        }
        if (response.id === 1) {
          if (initialized) { fail("protocol_error"); break; }
          if (response.error) { fail("initialize_rejected"); break; }
          if (!record(response.result)) { fail("protocol_error"); break; }
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (response.id === 2) {
          if (!initialized) { fail("protocol_error"); break; }
          if (response.error) { fail("rate_limits_rejected"); break; }
          finish(undefined, interpretCodexQuota(response.result, expectedAccountId));
        } // Ignore server notifications and unrelated requests/responses.
      }
    });
    send({
      id: 1, method: "initialize",
      params: {
        clientInfo: {
          name: "paperclip_watcher", title: "Paperclip Watcher", version: "1.0.0",
        },
      },
    });
  });
}
