import assert from "node:assert/strict";
import test from "node:test";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { WatcherConfig } from "../src/types.js";
import {
  isMissingDisposition,
  isWatcherRecoveryIssue,
  PaperclipWatcher,
} from "../src/watcher.js";

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

test("uses Paperclip-supported offset pagination for blocked attention", async () => {
  const pagingConfig = { ...config, pageSize: 2 };
  const urls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("offset=0")) return json([{ id: "a" }, { id: "b" }]);
    if (url.includes("offset=2")) return json([{ id: "c" }]);
    return json({ error: "unexpected" }, 500);
  };

  const client = new PaperclipClient(pagingConfig, fakeFetch);
  const issues = await client.listBlockedIssues("company-1");

  assert.deepEqual(issues.map((issue) => issue.id), ["a", "b", "c"]);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.match(url, /attention=blocked/);
    assert.doesNotMatch(url, /sortField=/);
    assert.doesNotMatch(url, /sortDir=/);
    assert.doesNotMatch(url, /afterId=/);
  }
});

test("creates a CEO recovery task for a verified active missing_disposition recovery", async () => {
  const requests: Array<{ url: string; method: string; body?: any }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, ...(body === undefined ? {} : { body }) });

    if (url.includes("/api/companies/company-1/issues?")) {
      return json([
        {
          id: "issue-1",
          identifier: "LAB-23",
          title: "Investigate liveness",
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
      return json({
        active: {
          id: "recovery-1",
          kind: "missing_disposition",
          cause: "successful_run_missing_state",
          nextAction: "Choose the final disposition.",
          evidence: { failureSummary: "Run succeeded without a final status." },
        },
      });
    }
    if (url === "http://paperclip.test/api/companies/company-1/issues" && method === "POST") {
      return json({
        id: "ceo-recovery-1",
        identifier: "LAB-99",
        title: "[Paperclip Watcher Recovery] LAB-23: missing disposition",
      }, 201);
    }
    return json({ error: "unexpected request" }, 500);
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();

  assert.deepEqual(result, { scanned: 2, candidates: 1, escalated: 1 });
  const create = requests.find(
    (request) =>
      request.url === "http://paperclip.test/api/companies/company-1/issues" &&
      request.method === "POST",
  );
  assert.ok(create);
  assert.equal(create.body.title, "[Paperclip Watcher Recovery] LAB-23: missing disposition");
  assert.equal(create.body.assigneeAgentId, "ceo-1");
  assert.equal(create.body.status, "todo");
  assert.equal(create.body.priority, "high");
  assert.equal(create.body.allowDuplicate, true);
  assert.equal(
    create.body.idempotencyKey,
    "paperclip-watcher:missing-disposition:recovery-1",
  );
  assert.match(create.body.description, /Source issue ID: issue-1/);
  assert.match(create.body.description, /Recovery action ID: recovery-1/);
  assert.match(create.body.description, /Do not take ownership of the source task/);
  assert.equal(requests.some((request) => request.url.includes("/wakeup")), false);

  const second = await watcher.pollOnce();
  assert.deepEqual(second, { scanned: 2, candidates: 1, escalated: 0 });
  assert.equal(
    requests.filter(
      (request) =>
        request.url === "http://paperclip.test/api/companies/company-1/issues" &&
        request.method === "POST",
    ).length,
    1,
  );
});

test("accepts an idempotently replayed CEO recovery task without re-escalating", async () => {
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/companies/company-1/issues?")) {
      return json([
        {
          id: "issue-1",
          identifier: "LAB-23",
          blockedInboxAttention: { state: "missing_disposition" },
        },
      ]);
    }
    if (url.endsWith("/api/issues/issue-1/recovery-actions")) {
      return json({ active: { id: "recovery-1", kind: "missing_disposition" } });
    }
    if (url === "http://paperclip.test/api/companies/company-1/issues" && init?.method === "POST") {
      return json({
        id: "ceo-recovery-1",
        identifier: "LAB-99",
        deduplicated: true,
        deduplicationReason: "idempotency_key",
      });
    }
    return json({ error: "unexpected request" }, 500);
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();
  assert.deepEqual(result, { scanned: 1, candidates: 1, escalated: 0 });
});

test("does not create a CEO recovery task when attention is stale", async () => {
  let created = false;
  const fakeFetch: typeof fetch = async (input, init) => {
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
    if (init?.method === "POST") created = true;
    return json({});
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();
  assert.deepEqual(result, { scanned: 1, candidates: 1, escalated: 0 });
  assert.equal(created, false);
});

test("suppresses recursive recovery tasks", async () => {
  let recoveryLookup = false;
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/companies/company-1/issues?")) {
      return json([
        {
          id: "recovery-task",
          title: "[Paperclip Watcher Recovery] LAB-23: missing disposition",
          blockedInboxAttention: { state: "missing_disposition" },
        },
      ]);
    }
    if (url.includes("/recovery-actions")) recoveryLookup = true;
    return json({});
  };

  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fakeFetch));
  const result = await watcher.pollOnce();
  assert.deepEqual(result, { scanned: 1, candidates: 1, escalated: 0 });
  assert.equal(recoveryLookup, false);
  assert.equal(
    isWatcherRecoveryIssue({
      id: "recovery-task",
      title: "[Paperclip Watcher Recovery] source",
    }),
    true,
  );
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
