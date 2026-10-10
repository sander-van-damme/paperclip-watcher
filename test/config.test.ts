import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("CEO Task Watchdog is unconditional, with no enable/disable configuration switch", () => {
  const keys = [
    "PAPERCLIP_API_URL",
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_CTO_AGENT_ID",
    "PAPERCLIP_WATCHER_TASK_WATCHDOG_SCAN_INTERVAL_MS",
  ] as const;
  const original = keys.map(key => [key, process.env[key]] as const);
  try {
    process.env.PAPERCLIP_API_URL = "http://paperclip.test:3100";
    process.env.PAPERCLIP_API_KEY = "test-token";
    process.env.PAPERCLIP_CTO_AGENT_ID = "test-cto-id";
    delete process.env.PAPERCLIP_WATCHER_TASK_WATCHDOG_SCAN_INTERVAL_MS;

    const config = loadConfig();

    assert.equal(config.ctoAgentId, "test-cto-id");
    assert.equal(config.taskWatchdogScanIntervalMs, 60_000);
    assert.equal(Object.hasOwn(config, "taskWatchdogEnabled"), false);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
