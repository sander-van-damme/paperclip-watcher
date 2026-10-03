import assert from "node:assert/strict";
import test from "node:test";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { WatcherConfig } from "../src/types.js";
import { isMissingDisposition, PaperclipWatcher } from "../src/watcher.js";

const config: WatcherConfig = {
  apiUrl: "http://paperclip.test",
  apiKey: "secret",
  ceoAgentId: "ceo-1",
  companyId: "company-1",
  pollIntervalMs: 15_000,
  requestTimeoutMs: 10_000,
  pageSize: 100,
  dryRun: false,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("classifies Paperclip missing-disposition attention", () => {
  assert.equal(
    isMissingDisposition({
      id: "issue-1",
      blockedInboxAttention: { state: "missing_disposition" },
    }),
    true,
  );
  assert.equal(
    isMissingDisposition({
      id: "issue-2",
      blockedInboxAttention: { reason: "missing_successful_run_disposition" },
    }),
    true,
  );
  assert.equal(
    isMissingDisposition({
      id: "issue-3",
      blockedInboxAttention: { state: "awaiting_decision" },
    }),
    false,
  );
});

test("wakes CEO for a verified active missing_disposition recovery", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });

    if (url.includes("/api/companies/company-1/issues?")) {
      return json([
        {
          id: "issue-1",
          identifier: "LAB-23",
          status: "in_progress",
          assigneeAgentId: "sub-agent-1",
          blockedInboxAttention: {
            state: "missing_disposition",
            reason: "missing_successful_run_disposition",
          },
        },
        {
          id: "issue-2",
          identifier: "LAB-24",
          blockedInboxAttention: { state: "awaiting_decision" },
        },
      ]);
    }
    if (url.endsWith("/api/issues/issue-1/recovery-actions")) {
      return json({ active: { id: "recovery-1", kind: "missing_disposition" } });
    }
    if (url.endsWith("/api/agents/ceo-1/wakeup")) {
      return json({ status: "queued" }, 202);
    }
    return json({ error: "unexpected request" }, 500);
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();

  assert.deepEqual(result, { scanned: 2, candidates: 1, escalated: 1 });
  const wake = requests.find((request) => request.url.endsWith("/api/agents/ceo-1/wakeup"));
  assert.ok(wake);
  assert.equal(wake.method, "POST");
  assert.deepEqual(wake.body, {
    source: "automation",
    triggerDetail: "system",
    reason: "missing_disposition_escalation",
    payload: {
      issueId: "issue-1",
      issueIdentifier: "LAB-23",
      recoveryActionId: "recovery-1",
      recoveryKind: "missing_disposition",
      watcher: "paperclip-watcher",
      instruction:
        "Paperclip detected a missing disposition for LAB-23. Inspect the source issue and recovery evidence, determine the correct disposition, and resolve the recovery without taking ownership of the source task unless that is an explicit decision.",
    },
    idempotencyKey: "paperclip-watcher:missing-disposition:recovery-1",
  });

  const second = await watcher.pollOnce();
  assert.deepEqual(second, { scanned: 2, candidates: 1, escalated: 0 });
  assert.equal(
    requests.filter((request) => request.url.endsWith("/api/agents/ceo-1/wakeup")).length,
    1,
  );
});

test("does not wake CEO when attention is stale and active recovery changed", async () => {
  let woke = false;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/companies/company-1/issues?")) {
      return json([
        {
          id: "issue-1",
          blockedInboxAttention: { state: "missing_disposition" },
        },
      ]);
    }
    if (url.endsWith("/api/issues/issue-1/recovery-actions")) {
      return json({ active: { id: "recovery-2", kind: "workspace_validation" } });
    }
    if (url.includes("/wakeup")) woke = true;
    return json({});
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();
  assert.deepEqual(result, { scanned: 1, candidates: 1, escalated: 0 });
  assert.equal(woke, false);
});

test("derives company id from CEO agent when not configured", async () => {
  const derivedConfig: WatcherConfig = { ...config };
  delete derivedConfig.companyId;
  const seen: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/api/agents/ceo-1")) {
      return json({ id: "ceo-1", companyId: "company-derived", name: "CEO" });
    }
    if (url.includes("/api/companies/company-derived/issues?")) return json([]);
    return json({ error: "unexpected" }, 500);
  };

  const watcher = new PaperclipWatcher(
    derivedConfig,
    new PaperclipClient(derivedConfig, fakeFetch),
  );
  const result = await watcher.pollOnce();
  assert.deepEqual(result, { scanned: 0, candidates: 0, escalated: 0 });
  assert.ok(seen.some((url) => url.endsWith("/api/agents/ceo-1")));
});
