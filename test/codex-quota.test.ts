import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretCodexQuota } from "../src/codex-quota.js";
import { CodexQuotaMonitor } from "../src/codex-quota-monitor.js";
import type { QuotaSnapshot } from "../src/codex-quota.js";

function payload(primary = 30, secondary = 40, overrides: Record<string, unknown> = {}) {
  return {
    ordinaryUsageAllowed: true,
    accountId: "correct-account",
    rateLimits: { primary: { usedPercent: primary }, secondary: { usedPercent: secondary } },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: primary, windowDurationMins: 300 },
               secondary: { usedPercent: secondary, windowDurationMins: 10080 } },
    },
    ...overrides,
  };
}
test("Codex quota parser reads both windows; weekly exhaustion overrides five-hour availability", () => {
  assert.equal(interpretCodexQuota(payload(10, 99)).availability, "available");
  assert.equal(interpretCodexQuota(payload(10, 100)).availability, "exhausted");
  assert.equal(interpretCodexQuota(payload(100, 10)).availability, "exhausted");
  assert.equal(interpretCodexQuota(payload(10, 20, {ordinaryUsageAllowed:false})).availability,"exhausted");
});
test("Codex never guesses recovery from time, credits, wrong account or missing backend permission", () => {
  assert.equal(interpretCodexQuota(payload(0, 0, {ordinaryUsageAllowed:null})).availability,"unknown");
  assert.equal(interpretCodexQuota(payload(0, 0), "different-account").availability,"unknown");
  assert.equal(interpretCodexQuota(payload(0, 0, {rateLimitsByLimitId: {base_model_inference: {primary: {usedPercent:1}}}})).availability,"unknown");
  assert.equal(interpretCodexQuota(payload(0, 0, {rateLimitResetCredits:{availableCount:3},ordinaryUsageAllowed:false})).availability,"exhausted");
  assert.equal(interpretCodexQuota(payload(0, 0, {rateLimitsByLimitId:{codex:{primary:{usedPercent:0},rateLimitReachedType:"rate_limit_reached"}}})).availability,"exhausted");
  assert.equal(interpretCodexQuota(payload(0, 0, {rateLimitsByLimitId:{codex:{primary:{usedPercent:NaN}}}})).availability,"unknown");
});

test("quota recovery epoch is persisted and never increments repeatedly or on unknown samples", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-quota-test-"));
  try {
    const exhausted: QuotaSnapshot = {availability:"exhausted",accountId:"a",reason:"window_exhausted"};
    const available: QuotaSnapshot = {availability:"available",accountId:"a",reason:"backend_allows_usage"};
    let next: QuotaSnapshot = exhausted;
    const a = new CodexQuotaMonitor(dir, async () => next);
    assert.deepEqual((await a.poll()),{availability:"exhausted",recoveryEpoch:0,reason:"window_exhausted"});
    next = available;
    assert.equal((await a.poll()).recoveryEpoch, 1);
    const b = new CodexQuotaMonitor(dir, async () => next);
    assert.equal((await b.poll()).recoveryEpoch, 1);
    next = {availability:"unknown",accountId:null,reason:"backend_permission_unknown"};
    assert.equal((await b.poll()).recoveryEpoch, 1);
    next = exhausted;
    await b.poll();
    next = available;
    assert.equal((await b.poll()).recoveryEpoch, 2);
    const failing = new CodexQuotaMonitor(dir, async () => { throw new Error("credentials confidential"); });
    assert.deepEqual(await failing.poll(), {
      availability:"unknown",recoveryEpoch:2,reason:"codex_probe_failed",
    });
  } finally { await rm(dir,{recursive:true,force:true}); }
});
