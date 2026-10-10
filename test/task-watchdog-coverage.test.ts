import assert from "node:assert/strict";
import test from "node:test";
import { TaskWatchdogCoverageSupervisor } from "../src/task-watchdog-coverage.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { TaskWatchdogCoverageStore } from "../src/task-watchdog-state.js";
import type { IssueSummary, TaskWatchdogSummary, WatcherConfig } from "../src/types.js";

const config: WatcherConfig = {
  apiUrl: "http://paperclip.test", apiKey: "test-board-token",
  ctoAgentId: "cto", companyId: "company",
  pollIntervalMs: 15000, requestTimeoutMs: 10000, pageSize: 500,
  idleGraceMs: 60000, cooldownMs: 300000,
  stateDir: "/tmp/test-campaign", dryRun: false,
  taskWatchdogEnabled: true, taskWatchdogScanIntervalMs: 60000,
  taskWatchdogMaxAttachmentsPerPoll: 1,
  taskWatchdogInstructions: "Verify stopped work; preserve legitimate blockers.",
};

function issue(
  id: string,
  status: string,
  parentId: string | null = null,
  assigneeAgentId: string | null = "cto",
  originKind: string | null = null,
): IssueSummary {
  return {
    id, identifier: "LAB-" + id, title: "Issue " + id, status,
    companyId: "company", parentId, originKind, assigneeAgentId,
  };
}

function rig(input: {
  issues: IssueSummary[];
  existingWatchdogs?: Record<string, string>;
  dryRun?: boolean;
  explicitCeo?: boolean;
  maxAttachments?: number;
  ceoStatus?: string;
  ctoStatus?: string;
  agentRoles?: [string, string];
  knownIds?: string[];
  ceoCount?: number;
}) {
  const allIssues = new Map(input.issues.map(record => [record.id, record]));
  const existing = new Map<string, TaskWatchdogSummary>(
    Object.entries(input.existingWatchdogs ?? {}).map(([issueId, watchdogAgentId]) => [
      issueId, { id: "watchdog-" + issueId, issueId, watchdogAgentId, status: "active" },
    ]),
  );
  const puts: Array<{ issueId: string; agentId: string; instructions: string }> = [];
  let known = [...(input.knownIds ?? [])];
  const store: TaskWatchdogCoverageStore = {
    async load() { return [...known]; },
    async save(ids) { known = [...ids]; },
  };
  const fetcher: typeof fetch = async (url, options) => {
    const u = new URL(String(url));
    const method = options?.method ?? "GET";
    if (u.pathname === "/api/agents/cto") {
      return Response.json({ id: "cto", companyId: "company", role: input.agentRoles?.[0] ?? "cto", status: input.ctoStatus ?? "idle" });
    }
    if (u.pathname === "/api/agents/ceo") {
      return Response.json({ id: "ceo", companyId: "company", role: input.agentRoles?.[1] ?? "ceo", status: input.ceoStatus ?? "idle" });
    }
    if (u.pathname === "/api/companies/company/agents") {
      return Response.json([
        { id: "cto", companyId: "company", role: input.agentRoles?.[0] ?? "cto", status: input.ctoStatus ?? "idle" },
        ...Array.from({length: input.ceoCount ?? 1}, (_, index) => ({
          id: index ? "ceo-" + index : "ceo",
          companyId: "company",
          role: input.agentRoles?.[1] ?? "ceo",
          status: input.ceoStatus ?? "idle",
        })),
      ]);
    }
    if (u.pathname === "/api/companies/company/issues") {
      assert.equal(u.searchParams.get("assigneeAgentId"), "cto");
      return Response.json(input.issues.filter(record => record.assigneeAgentId === "cto"));
    }
    const match = /^\/api\/issues\/([^/]+)(\/watchdog)?$/.exec(u.pathname);
    if (match) {
      const id = match[1]!;
      if (match[2] === "/watchdog") {
        if (method === "GET") return Response.json(existing.get(id) ?? null);
        assert.equal(method, "PUT");
        const body = JSON.parse(String(options?.body ?? "{}")) as { agentId: string; instructions: string };
        puts.push({issueId: id, agentId: body.agentId, instructions: body.instructions});
        const watchdog: TaskWatchdogSummary = {id: "watchdog-"+id,issueId:id,watchdogAgentId:body.agentId,status:"active"};
        existing.set(id, watchdog);
        return Response.json(watchdog);
      }
      if (method === "GET" && allIssues.has(id)) return Response.json(allIssues.get(id));
      return new Response("Not found", {status:404});
    }
    throw new Error("Unexpected API " + method + " " + u.pathname);
  };
  const cfg: WatcherConfig = {
    ...config,
    dryRun: input.dryRun ?? false,
    taskWatchdogMaxAttachmentsPerPoll: input.maxAttachments ?? 1,
    ...(input.explicitCeo ? {ceoAgentId: "ceo"} : {}),
  };
  const client = new PaperclipClient(cfg, fetcher);
  const newSupervisor = () => new TaskWatchdogCoverageSupervisor(cfg, client, store);
  return { newSupervisor, puts, existing, getKnown: () => [...known] };
}

test("covers CTO campaigns AND standalone CTO tasks, not their children", async () => {
  const x = rig({issues: [
    issue("parent", "blocked"),
    issue("child-a", "done", "parent"),
    issue("child-b", "todo", "parent"),
    issue("loose", "in_progress"),
  ]});
  const supervisor = x.newSupervisor();
  const first = await supervisor.pollOnce();
  assert.equal(first.candidates, 3);
  assert.equal(first.coveredByAncestor, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["parent"]);
  const second = await supervisor.pollOnce();
  assert.equal(second.attached, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["parent", "loose"]);
  assert.equal((await supervisor.pollOnce()).attached, 0);
  assert.equal(x.puts.length, 2);
});

test("protects CTO subtasks when parent belongs to another agent", async () => {
  const x = rig({issues: [
    issue("outside", "in_progress", null, "engineer"),
    issue("cto-child", "todo", "outside"),
  ]});
  assert.equal((await x.newSupervisor().pollOnce()).attached, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["cto-child"]);
});

test("an existing watchdog on any ancestor covers the CTO child", async () => {
  const x = rig({
    issues: [
      issue("other-root", "blocked", null, "engineer"),
      issue("other-parent", "todo", "other-root", "engineer"),
      issue("cto-child", "blocked", "other-parent"),
    ],
    existingWatchdogs: { "other-root": "independent-auditor" },
  });
  const state = await x.newSupervisor().pollOnce();
  assert.equal(state.coveredByAncestor, 1);
  assert.equal(state.attached, 0);
  assert.equal(x.puts.length, 0);
});

test("does not attach to terminal CTO tasks, but does cover a live child of a terminal parent", async () => {
  const x = rig({issues: [issue("done-root", "done"), issue("cancelled-root", "cancelled"),
    issue("active-child", "blocked", "done-root")]});
  assert.equal((await x.newSupervisor().pollOnce()).attached, 1);
  assert.deepEqual(x.puts.map(p => p.issueId), ["active-child"]);
});

test("does not protect task-watchdog-origin work or descendants", async () => {
  const x = rig({issues: [
    issue("watchdog-review", "in_progress", null, "cto", "task_watchdog"),
    issue("watchdog-child", "todo", "watchdog-review"),
  ]});
  const r = await x.newSupervisor().pollOnce();
  assert.equal(r.attached, 0);
  assert.equal(r.coveredByAncestor, 1);
});

test("does not overwrite existing manual watchdog; remembers subsequent removal across restarts", async () => {
  const x = rig({issues:[issue("root", "blocked")],existingWatchdogs:{"root":"other-auditor"}});
  const a = x.newSupervisor();
  assert.equal((await a.pollOnce()).alreadyConfigured, 1);
  assert.deepEqual(x.getKnown(), ["root"]);
  x.existing.delete("root"); // operator explicitly disabled the watchdog
  const b = x.newSupervisor();
  assert.equal((await b.pollOnce()).skippedKnown, 1);
  assert.equal(x.puts.length, 0);
});

test("auto-discovers CEO, also accepts an explicit CEO ID", async () => {
  const x=rig({issues:[issue("root","blocked")],explicitCeo:true});
  assert.equal((await x.newSupervisor().pollOnce()).attached,1);
  assert.equal(x.puts[0]?.agentId,"ceo");
});
test("fails closed for ambiguous or paused CEO", async () => {
  for (const x of [
    rig({issues:[issue("root","todo")],ceoCount:2}),
    rig({issues:[issue("root","todo")],ceoStatus:"paused"}),
  ]) {
    await assert.rejects(x.newSupervisor().pollOnce());
    assert.equal(x.puts.length,0);
  }
});
test("dry run and pre-existing tracking prevent any PUT", async () => {
  const x=rig({issues:[issue("root","blocked")],dryRun:true});
  assert.equal((await x.newSupervisor().pollOnce()).dryRunCandidates,1);
  assert.deepEqual(x.puts,[]);
  const y=rig({issues:[issue("root","todo")],knownIds:["root"]});
  assert.equal((await y.newSupervisor().pollOnce()).skippedKnown,1);
  assert.deepEqual(y.puts,[]);
});
test("invalid or cyclic parent topology fails closed", async () => {
  const x=rig({issues:[issue("a","blocked","b"), issue("b","todo","a","engineer")]});
  await assert.rejects(x.newSupervisor().pollOnce());
  assert.equal(x.puts.length,0);
});
