import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PaperclipWatcher } from "../src/watcher.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { IssueSummary, WatcherConfig, WatcherState } from "../src/types.js";

const config: WatcherConfig = {
  apiUrl: "http://paperclip.test", apiKey: "secret", ctoAgentId: "cto",
  companyId: "company", pollIntervalMs: 15000, requestTimeoutMs: 10000,
  pageSize: 500, idleGraceMs: 60000, cooldownMs: 300000,
  stateDir: "/tmp/test", dryRun: false,
  taskWatchdogEnabled: false, taskWatchdogScanIntervalMs: 60000,
  taskWatchdogMaxAttachmentsPerPoll: 1, taskWatchdogInstructions: "Review stopped work.",
};
function rig(runStatus = "succeeded", agentStatus = "idle", initialState?: WatcherState) {
  let issues: IssueSummary[] = [{ id: "task", status: "in_progress", assigneeAgentId: "cto" }];
  let now = 0, wakes = 0;
  let saved: WatcherState = initialState ? {...initialState} : {lastHandledSignature: null, lastWakeAt: null};
  const fetcher: typeof fetch = async (url, opts) => {
    const path = String(url);
    if (path.endsWith("/api/agents/cto")) return Response.json({id:"cto",companyId:"company",status:agentStatus});
    if (path.includes("/issues?")) return Response.json(issues);
    if (path.includes("/heartbeat-runs?")) return Response.json([{id:"run",agentId:"cto",status:runStatus,livenessState:"completed"}]);
    if (path.endsWith("/wakeup") && opts?.method === "POST") {wakes++; return Response.json({id:"wake",status:"queued"});}
    throw new Error("Unexpected path " + path);
  };
  const store = {
    async load() {return {...saved};},
    async save(value: WatcherState) {saved = {...value};},
  };
  const watcher = new PaperclipWatcher(config, new PaperclipClient(config, fetcher), store, () => now);
  return {
    watcher, setIssues: (status: string) => {issues = [{id:"task",status,assigneeAgentId:"cto"}];},
    setIssuesData: (value: IssueSummary[]) => { issues = value; },
    advance: (ms: number) => {now += ms;}, wakes: () => wakes,
  };
}

test("wakes once after CTO issue becomes done and grace elapses", async () => {
  const r = rig();
  assert.equal((await r.watcher.pollOnce()).state, "outstanding_issues");
  r.setIssues("done");
  assert.equal((await r.watcher.pollOnce()).state, "settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state, "woken");
  await r.watcher.pollOnce();
  assert.equal(r.wakes(), 1);
});
test("no wake for queued, running, scheduled_retry, failed or timed_out runs", async () => {
  for (const status of ["queued","running","scheduled_retry","failed","timed_out"]) {
    const r = rig(status);
    await r.watcher.pollOnce();
    r.setIssues("done");
    r.advance(60000);
    await r.watcher.pollOnce();
    assert.equal(r.wakes(), 0, status);
  }
});
test("nonterminal issues prevent wake", async () => {
  for (const status of ["backlog","todo","in_progress","in_review","blocked","unexpected"]) {
    const r=rig();
    r.setIssues(status);
    await r.watcher.pollOnce();
    r.advance(60000);
    await r.watcher.pollOnce();
    assert.equal(r.wakes(),0,status);
  }
});
test("first startup with only closed tasks wakes once after grace",async()=>{
  const r=rig();
  r.setIssues("cancelled");
  assert.equal((await r.watcher.pollOnce()).state,"settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"woken");
  assert.equal((await r.watcher.pollOnce()).state,"already_handled");
  assert.equal(r.wakes(),1);
});
test("migrates a previously handled bootstrap baseline without a wake",async()=>{
  const signature = createHash("sha256").update(JSON.stringify([["task","done",null,null]])).digest("hex");
  const r=rig("succeeded","idle",{lastHandledSignature:signature,lastWakeAt:null});
  r.setIssues("done");
  assert.equal((await r.watcher.pollOnce()).state,"settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"woken");
  assert.equal(r.wakes(),1);
});
test("does not repeat a wake for a previously handled terminal snapshot",async()=>{
  const signature = createHash("sha256").update(JSON.stringify([["task","done",null,null]])).digest("hex");
  const r=rig("succeeded","idle",{lastHandledSignature:signature,lastWakeAt:1});
  r.setIssues("done");
  assert.equal((await r.watcher.pollOnce()).state,"already_handled");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"already_handled");
  assert.equal(r.wakes(),0);
});
test("paused CTO is not woken", async()=>{
  const r=rig("succeeded","paused");
  await r.watcher.pollOnce();
  r.setIssues("done");
  r.advance(60000);
  await r.watcher.pollOnce();
  assert.equal(r.wakes(),0);
});

test("outstanding diagnostics show actual blockers, not total assigned issues", async () => {
  const r = rig();
  r.setIssuesData([
    { id: "parent", identifier: "LAB-221", title: "Campaign: direct heads", status: "blocked", assigneeAgentId: "cto" },
    { id: "done", identifier: "LAB-223", status: "done", assigneeAgentId: "cto" },
    { id: "cancel", identifier: "LAB-224", status: "cancelled", assigneeAgentId: "cto" },
  ]);
  const result = await r.watcher.pollOnce();
  assert.equal(result.state, "outstanding_issues");
  assert.equal(result.assignedCount, 3);
  assert.equal(result.outstandingCount, 1);
  assert.deepEqual(result.outstandingIssues, [
    { id: "parent", identifier: "LAB-221", title: "Campaign: direct heads", status: "blocked" },
  ]);
  assert.equal(result.omittedOutstandingCount, 0);
  assert.equal(r.wakes(), 0);
});

test("diagnostics cap the list but retain the full outstanding count", async () => {
  const r = rig();
  r.setIssuesData(Array.from({length: 35}, (_, index) => ({
    id: "issue-" + index,
    identifier: "LAB-" + index,
    status: "todo",
    assigneeAgentId: "cto",
  })));
  const result = await r.watcher.pollOnce();
  assert.equal(result.assignedCount, 35);
  assert.equal(result.outstandingCount, 35);
  assert.equal(result.outstandingIssues?.length, 30);
  assert.equal(result.omittedOutstandingCount, 5);
});

test("a running CTO is busy, not unavailable, and must not receive another wake", async () => {
  const r=rig("succeeded","running");
  assert.equal((await r.watcher.pollOnce()).state,"agent_running");
  r.setIssues("done");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"agent_running");
  assert.equal(r.wakes(),0);
});
