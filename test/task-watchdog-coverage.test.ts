import assert from "node:assert/strict";
import test from "node:test";
import { TaskWatchdogCoverageSupervisor } from "../src/task-watchdog-coverage.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { TaskWatchdogCoverageStore } from "../src/task-watchdog-state.js";
import type { IssueRunSummary, IssueSummary, TaskWatchdogSummary, WatcherConfig } from "../src/types.js";

const TEN_MINUTES = 600_000;
const config: WatcherConfig = {
  apiUrl: "http://paperclip.test", apiKey: "test-board-token",
  ctoAgentId: "cto", companyId: "company",
  pollIntervalMs: 15000, requestTimeoutMs: 10000, pageSize: 500,
  idleGraceMs: 60000, cooldownMs: 300000,
  stateDir: "/tmp/test-campaign", dryRun: false,
  taskWatchdogScanIntervalMs: 60000,
  taskWatchdogMaxAttachmentsPerPoll: 1,
  taskWatchdogInstructions: "Investigate evidence-backed stops.",
};

function issue(id: string, status: string,
               parentId: string | null = null,
               assigneeAgentId: string | null = "cto",
               originKind: string | null = null): IssueSummary {
  return {
    id, identifier: "LAB-" + id, title: "Issue " + id, status,
    companyId: "company", parentId, originKind, assigneeAgentId,
  };
}

function run(runId: string, status: string, errorCode: string | null = "adapter_failed"): IssueRunSummary {
  return { runId, agentId: "cto", status, errorCode, createdAt: "2026-10-11T20:00:00Z" };
}

function rig(input: {
  issues: IssueSummary[];
  issueDetails?: Record<string, Partial<IssueSummary>>;
  issueRuns?: Record<string, IssueRunSummary[]>;
  existingWatchdogs?: Record<string, string>;
  knownIds?: string[];
  dryRun?: boolean;
  ceoStatus?: string;
  ctoStatus?: string;
  ceoCount?: number;
  maxAttachments?: number;
  explicitCeo?: boolean;
  onDetailRead?: (id: string, count: number) => Partial<IssueSummary> | null;
}) {
  const allIssues = new Map(input.issues.map(item => [item.id, item]));
  const details = new Map(Object.entries(input.issueDetails ?? {}));
  const runs = new Map(Object.entries(input.issueRuns ?? {}));
  const existing = new Map<string, TaskWatchdogSummary>(
    Object.entries(input.existingWatchdogs ?? {}).map(([issueId, watchdogAgentId]) =>
      [issueId, { id: "watchdog-" + issueId, issueId, watchdogAgentId, status: "active" }]),
  );
  const detailReads = new Map<string, number>();
  const puts: Array<{ issueId: string; agentId: string; instructions: string }> = [];
  let known = [...(input.knownIds ?? [])];
  let now = 0;
  const store: TaskWatchdogCoverageStore = {
    async load() { return [...known]; },
    async save(ids) { known = [...ids]; },
  };
  const fetcher: typeof fetch = async (url, options) => {
    const u = new URL(String(url));
    const method = options?.method ?? "GET";
    if (u.pathname === "/api/agents/cto") {
      return Response.json({ id: "cto", companyId: "company", role: "cto", status: input.ctoStatus ?? "idle" });
    }
    if (u.pathname === "/api/agents/ceo") {
      return Response.json({ id: "ceo", companyId: "company", role: "ceo", status: input.ceoStatus ?? "idle" });
    }
    if (u.pathname === "/api/companies/company/agents") {
      return Response.json([
        { id: "cto", companyId: "company", role: "cto", status: input.ctoStatus ?? "idle" },
        ...Array.from({ length: input.ceoCount ?? 1 }, (_, index) => ({
          id: index ? "ceo-" + index : "ceo", companyId: "company",
          role: "ceo", status: input.ceoStatus ?? "idle",
        })),
      ]);
    }
    if (u.pathname === "/api/companies/company/issues") {
      assert.equal(u.searchParams.get("assigneeAgentId"), "cto");
      return Response.json([...allIssues.values()].filter(record => record.assigneeAgentId === "cto"));
    }
    const match = /^\/api\/issues\/([^/]+)(\/watchdog|\/runs)?$/.exec(u.pathname);
    if (match) {
      const id = match[1]!;
      if (match[2] === "/runs") return Response.json(runs.get(id) ?? []);
      if (match[2] === "/watchdog") {
        if (method === "GET") return Response.json(existing.get(id) ?? null);
        assert.equal(method, "PUT");
        const body = JSON.parse(String(options?.body ?? "{}")) as { agentId: string; instructions: string };
        puts.push({ issueId: id, agentId: body.agentId, instructions: body.instructions });
        const watchdog: TaskWatchdogSummary = {
          id: "watchdog-" + id, issueId: id, watchdogAgentId: body.agentId, status: "active",
        };
        existing.set(id, watchdog);
        return Response.json(watchdog);
      }
      if (method === "GET" && allIssues.has(id)) {
        const count = (detailReads.get(id) ?? 0) + 1;
        detailReads.set(id, count);
        const override = input.onDetailRead?.(id, count);
        return Response.json({
          ...allIssues.get(id), ...(details.get(id) ?? {}), ...(override ?? {}),
        });
      }
      return new Response("Not found", { status: 404 });
    }
    throw new Error("Unexpected API " + method + " " + u.pathname);
  };
  const cfg: WatcherConfig = {
    ...config,
    dryRun: input.dryRun ?? false,
    taskWatchdogMaxAttachmentsPerPoll: input.maxAttachments ?? 1,
    ...(input.explicitCeo ? { ceoAgentId: "ceo" } : {}),
  };
  const client = new PaperclipClient(cfg, fetcher);
  const newSupervisor = () => new TaskWatchdogCoverageSupervisor(cfg, client, store, () => now);
  return {
    newSupervisor, puts, existing, allIssues, details, runs, detailReads,
    advance(ms: number) { now += ms; },
    getKnown: () => [...known],
  };
}

test("normal CTO tasks never get native CEO watchdogs, including at completion", async () => {
  const x = rig({ issues: [
    issue("done", "done"), issue("cancel", "cancelled"), issue("backlog", "backlog"),
    issue("todo", "todo"), issue("work", "in_progress"), issue("block", "blocked"),
    issue("review", "in_review"),
  ]});
  const watch = x.newSupervisor();
  assert.equal((await watch.pollOnce()).detectedProblems, 0);
  x.advance(TEN_MINUTES * 5);
  assert.equal((await watch.pollOnce()).attached, 0);
  assert.deepEqual(x.puts, []);
});

test("stable terminal failure gets ONE CEO watchdog after grace", async () => {
  const x = rig({ issues: [issue("bad", "in_progress")],
    issueRuns: { bad: [run("r-1", "failed")] } });
  const supervisor = x.newSupervisor();
  const first = await supervisor.pollOnce();
  assert.equal(first.detectedProblems, 1);
  assert.equal(first.settlingProblems, 1);
  assert.equal(first.attached, 0);
  x.advance(TEN_MINUTES - 1);
  assert.equal((await supervisor.pollOnce()).attached, 0);
  x.advance(1);
  assert.equal((await supervisor.pollOnce()).attached, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["bad"]);
  assert.equal((await supervisor.pollOnce()).attached, 0);
});

test("temporary quota failure and scheduled recovery never wake CEO", async () => {
  const x = rig({ issues: [issue("quota", "todo"), issue("retry", "in_progress"),
      issue("recovering", "in_progress")],
    issueRuns: {
      quota: [run("q", "failed", "provider_quota")],
      retry: [run("r", "failed")],
      recovering: [run("c", "failed")],
    },
    issueDetails: {
      retry: { scheduledRetry: { status: "scheduled_retry" } },
      recovering: { activeRecoveryAction: { status: "active" } },
    },
  });
  const watch = x.newSupervisor();
  await watch.pollOnce(); x.advance(TEN_MINUTES * 2);
  assert.equal((await watch.pollOnce()).attached, 0);
  assert.deepEqual(x.puts, []);
});

test("progress or a changed failure resets the observation window", async () => {
  const x = rig({ issues: [issue("bad", "in_progress")], issueRuns: { bad: [run("r1", "failed")] } });
  const watch = x.newSupervisor();
  await watch.pollOnce();
  x.advance(TEN_MINUTES);
  x.runs.set("bad", [run("r2", "succeeded"), run("r1", "failed")]);
  assert.equal((await watch.pollOnce()).detectedProblems, 0);
  x.runs.set("bad", [run("r3", "failed"), run("r2", "succeeded")]);
  assert.equal((await watch.pollOnce()).settlingProblems, 1);
  assert.equal((await watch.pollOnce()).attached, 0);
  x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 1);
});

test("legitimate blocked and human review work stays alone", async () => {
  const x = rig({ issues: [issue("waiting", "blocked"), issue("human", "in_review"),
      issue("external", "blocked")],
    issueDetails: {
      human: { reviewAttention: { state: "covered", paths: [{ kind: "human_reviewer", ref: "user" }] } },
      external: { blockedInboxAttention: { state: "needs_attention", reason: "external_owner_action",
        owner: { type: "external" } } },
    },
  });
  const watch = x.newSupervisor();
  await watch.pollOnce(); x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).detectedProblems, 0);
});

test("verified stalled review and broken blocker path trigger selectively", async () => {
  const x = rig({ issues: [issue("stalled", "in_review"), issue("broken", "blocked")],
    issueDetails: {
      stalled: { reviewAttention: { state: "stalled", paths: [] } },
      broken: { blockedInboxAttention: { state: "needs_attention",
        reason: "blocked_chain_stalled", owner: { type: "agent" } } },
    },
    maxAttachments: 2,
  });
  const watch = x.newSupervisor();
  assert.equal((await watch.pollOnce()).detectedProblems, 2);
  x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 2);
  assert.deepEqual(x.puts.map(p => p.issueId).sort(), ["broken", "stalled"]);
});

test("a healthy CTO parent does not hide a stuck child", async () => {
  const x = rig({ issues: [issue("parent", "in_progress"), issue("child", "todo", "parent")],
    issueRuns: { child: [run("child-failure", "failed")] },
  });
  const watch = x.newSupervisor();
  assert.equal((await watch.pollOnce()).detectedProblems, 1);
  x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["child"]);
});

test("an existing watchdog on any ancestor covers the child; none are changed", async () => {
  const x = rig({ issues: [
    issue("root", "blocked", null, "engineer"),
    issue("child", "todo", "root"),
  ], issueRuns: { child: [run("r1", "failed")] },
    existingWatchdogs: { root: "custom-reviewer" },
  });
  const watch = x.newSupervisor();
  await watch.pollOnce(); x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 0);
  assert.deepEqual(x.puts, []);
  assert.equal(x.existing.get("root")?.watchdogAgentId, "custom-reviewer");
});

test("previously installed or manually disabled watchdogs are left untouched", async () => {
  const x = rig({ issues: [issue("root", "in_progress")],
    issueRuns: { root: [run("r1", "failed")] },
    existingWatchdogs: { root: "other" },
  });
  const watch = x.newSupervisor();
  assert.equal((await watch.pollOnce()).alreadyConfigured, 1);
  x.existing.delete("root");
  const restarted = x.newSupervisor();
  x.advance(TEN_MINUTES);
  assert.equal((await restarted.pollOnce()).skippedKnown, 1);
  assert.deepEqual(x.puts, []);
});

test("watchdog-origin tasks and their descendants are excluded", async () => {
  const x = rig({ issues: [
    issue("review", "in_progress", null, "cto", "task_watchdog"),
    issue("child", "todo", "review"),
  ], issueRuns: { child: [run("r1", "failed")] } });
  assert.equal((await x.newSupervisor().pollOnce()).detectedProblems, 0);
});

test("terminal parents are never watched, but genuinely stuck children can be", async () => {
  const x = rig({ issues: [issue("done", "done"), issue("child", "todo", "done")],
    issueRuns: { child: [run("r1", "failed")] } });
  const watch = x.newSupervisor(); await watch.pollOnce();
  x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 1);
  assert.equal(x.puts[0]?.issueId, "child");
});

test("a race to done immediately before attachment suppresses the write", async () => {
  const x = rig({ issues: [issue("bad", "in_progress")],
    issueRuns: { bad: [run("r1", "failed")] },
    onDetailRead: (id, count) => id === "bad" && count >= 3 ? { status: "done" } : null,
  });
  const watch = x.newSupervisor(); await watch.pollOnce(); x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).attached, 0);
  assert.deepEqual(x.puts, []);
});

test("dry run cannot attach even after the grace window", async () => {
  const x = rig({ issues: [issue("bad", "todo")],
    issueRuns: { bad: [run("r1", "failed")] }, dryRun: true });
  const watch = x.newSupervisor(); await watch.pollOnce(); x.advance(TEN_MINUTES);
  assert.equal((await watch.pollOnce()).dryRunCandidates, 1);
  assert.deepEqual(x.puts, []);
});

test("malformed or cyclic ancestry fails closed", async () => {
  const x = rig({ issues: [issue("a", "blocked", "b"), issue("b", "todo", "a", "engineer")] });
  await assert.rejects(x.newSupervisor().pollOnce(), /cyclic/);
  assert.deepEqual(x.puts, []);
});

test("paused or ambiguous CEO fails closed instead of attaching", async () => {
  for (const x of [
    rig({ issues: [issue("root", "todo")], ceoCount: 2 }),
    rig({ issues: [issue("root", "todo")], ceoStatus: "paused" }),
    rig({ issues: [issue("root", "todo")], ctoStatus: "paused" }),
  ]) {
    await assert.rejects(x.newSupervisor().pollOnce());
    assert.deepEqual(x.puts, []);
  }
});
