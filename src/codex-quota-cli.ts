import { loadConfig } from "./config.js";
import { CodexQuotaProbeError, readLocalCodexQuota } from "./codex-quota.js";

const hints: Record<string, string> = {
  binary_not_found: "Codex executable was not found. Check: command -v codex; or set PAPERCLIP_WATCHER_CODEX_BIN to its absolute path.",
  launch_failed: "Codex could not start. Check executable permissions, architecture and its installation.",
  initialize_rejected: "Codex rejected the initialization handshake. Check: codex --version and codex app-server --help.",
  rate_limits_rejected: "Codex rejected the rate-limit request. Check: codex login status; confirm the CLI supports account/rateLimits/read.",
  protocol_error: "The local Codex App Server returned an unexpected protocol response. Check the installed Codex version.",
  connection_closed: "Codex exited before the quota response. Check: codex --version; codex login status; and the CLI path.",
  timeout: "Codex did not answer the read-only quota request within the timeout. Check CLI version and local authentication.",
  response_too_large: "Codex returned an unexpectedly large response. Check CLI version.",
};

const config = loadConfig();
if (!config.codexQuota) {
  console.error("Enable PAPERCLIP_WATCHER_CODEX_QUOTA_ENABLED=true in the private .env first.");
  process.exitCode = 1;
} else {
  readLocalCodexQuota(config.codexQuota.executable, config.codexQuota.expectedAccountId)
    .then(result => {
      console.log(JSON.stringify({ availability: result.availability, reason: result.reason }, null, 2));
      if (result.availability === "unknown") {
        console.error("Quota availability is unknown; do not enable quota-triggered wakes until validated.");
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      const code = error instanceof CodexQuotaProbeError ? error.code : "unexpected";
      console.error("Codex quota check failed [" + code + "]. " +
        (hints[code] ?? "An unexpected local error occurred. Check Codex installation."));
      process.exitCode = 1;
    });
}
