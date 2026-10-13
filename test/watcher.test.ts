import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PaperclipWatcher } from "../src/watcher.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { IssueSummary, IssueInteractionSummary, WatcherConfig, WatcherState } from "../src/types.js";

const config: WatcherConfig = {
  apiUrl: "http://paperclip.test", apiKey: "secret", ctoAgentId: "cto",
  companyId: "company", pollIntervalMs: 15000, requestTimeoutMs: 10000,
  pageSize: 500, idleGraceMs: 60000, cooldownMs: 300000,
  stateDir: "/tmp/test", dryRun: false,
  taskWatchdogScanIntervalMs: 60000,
  taskWatchdogMaxAttachmentsPerPoll: 1, taskWatchdogInstructions: "Review stopped work.",
};
function rig(runStatus = "succeeded", agentStatus = "idle", initialState?: WatcherState) {
  let issues: IssueSummary[] = [{ id: "task", status: "in_progress", assigneeAgentId: "cto" }];
  let now = 0, wakes = 0;
  let liveness = "completed";
  let runError: string | null = null;
  let runIssue: string | null = null;
  let comments: Array<{id:string;body:string;authorAgentId:string;createdByRunId:string}> = [];
  let interactions: IssueInteractionSummary[] = [];
  let saved: WatcherState = initialState ? {...initialState} : {lastHandledSignature: null, lastWakeAt: null};
  const fetcher: typeof fetch = async (url, opts) => {
    const path = String(url);
    if (path.endsWith("/api/agents/cto")) return Response.json({id:"cto",companyId:"company",status:agentStatus});
    if (path.includes("/issues?")) return Response.json(issues);
    if (path.endsWith("/api/issues/task/interactions")) return Response.json(interactions);
    if (path.endsWith("/api/issues/task/comments?order=desc&limit=50")) return Response.json(comments);
    if (path.endsWith("/api/issues/task")) return Response.json({
      ...issues[0], companyId:"company",
    });
    // Paperclip's list can omit errorCode/contextSnapshot; only run detail is authoritative.
    if (path.endsWith("/api/heartbeat-runs/run")) return Response.json({
      id:"run",agentId:"cto",status:runStatus,livenessState:liveness,
      errorCode:runError,contextSnapshot:runIssue ? {issueId:runIssue} : null,
    });
    if (path.includes("/heartbeat-runs?")) return Response.json([{
      id:"run",agentId:"cto",status:runStatus,livenessState:liveness,
    }]);
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
    setInteractions: (value: IssueInteractionSummary[]) => { interactions = value; },
    advance: (ms: number) => {now += ms;}, wakes: () => wakes,
    setLiveness: (v: string) => {liveness=v;},
    setRunError: (v: string) => {runError=v;},
    setRunIssue: (v: string | null) => {runIssue=v;},
    setComments: (v: typeof comments) => {comments=v;},
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
  for (const status of ["todo","in_progress","in_review","blocked","unexpected"]) {
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

test("backlog permits one CTO wake per snapshot and never repeats on cooldown", async () => {
  const r = rig();
  r.setIssues("backlog");
  assert.equal((await r.watcher.pollOnce()).state,"settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"woken");
  assert.equal(r.wakes(),1);
  r.advance(600000);
  assert.equal((await r.watcher.pollOnce()).state,"already_handled");
  assert.equal(r.wakes(),1);
});

test("a backlog does not bypass actual actionable CTO work", async () => {
  const r=rig();
  r.setIssuesData([
    {id:"task",status:"backlog",assigneeAgentId:"cto"},
    {id:"todo",status:"todo",assigneeAgentId:"cto"},
  ]);
  const state=await r.watcher.pollOnce();
  assert.equal(state.state,"outstanding_issues");
  assert.equal(state.outstandingCount,1);
  assert.equal(state.parkedBacklogCount,1);
  assert.equal(r.wakes(),0);
});

test("human-reviewer review path allows CTO to proceed", async () => {
  const r=rig();
  r.setIssuesData([{
    id:"task",companyId:"company",status:"in_review",assigneeAgentId:"cto",
    reviewAttention:{state:"covered",paths:[{kind:"human_reviewer",ref:"board-user"}]},
  }]);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
  r.advance(60000);
  const result=await r.watcher.pollOnce();
  assert.equal(result.state,"waiting_for_human");
  assert.equal(result.humanReviewCount,1);
  assert.equal(r.wakes(),0);
});

test("human execution participant is verified using authoritative issue detail", async () => {
  const r=rig();
  r.setIssuesData([{
    id:"task",companyId:"company",status:"in_review",assigneeAgentId:"cto",
    executionState:{status:"pending",currentParticipant:{type:"user",userId:"reviewer"}},
    reviewAttention:{state:"covered",paths:[{kind:"execution_participant",ref:"reviewer"}]},
  }]);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
});

test("human-only interactions and formal approvals are human review paths", async () => {
  const r=rig();
  r.setIssuesData([{
    id:"task",companyId:"company",status:"in_review",assigneeAgentId:"cto",
    reviewAttention:{state:"covered",paths:[
      {kind:"interaction",ref:"interaction-1"},
      {kind:"approval",ref:"approval-1"},
    ]},
  }]);
  r.setInteractions([{
    id:"interaction-1",status:"pending",
    effectiveResolverPolicy:"human_only",addresseeAgentId:null,
  }]);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
});

test("agent review and unknown review paths still block", async () => {
  const variants: IssueSummary[] = [
    {id:"task",status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"execution_participant",ref:"agent-reviewer"}]},
      executionState:{status:"pending",currentParticipant:{type:"agent",agentId:"agent-reviewer"}}},
    {id:"task",status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"stalled",paths:[]}},
    {id:"task",status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"human_reviewer",ref:"board-user"},{kind:"queued_wake",ref:"queued-run"}]}},
    {id:"task",status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"interaction",ref:"agent-interaction"}]}},
  ];
  for (const variant of variants) {
    const r=rig();
    r.setIssuesData([variant]);
    r.setInteractions([{id:"agent-interaction",status:"pending",effectiveResolverPolicy:"anyone",
      addresseeAgentId:"other-agent"}]);
    assert.equal((await r.watcher.pollOnce()).state,"outstanding_issues");
    r.advance(60000);
    assert.equal(r.wakes(),0);
  }
});

test("backlog never bypasses pending retries or rate-limit failures", async () => {
  for (const status of ["queued","running","scheduled_retry","failed","timed_out"]) {
    const r=rig(status);
    r.setIssues("backlog");
    r.advance(60000);
    const result=await r.watcher.pollOnce();
    assert.notEqual(result.state,"woken",status);
    assert.equal(r.wakes(),0,status);
  }
});

test("parked eligibility invalidates the old blocked baseline on upgrade", async () => {
  const legacy = createHash("sha256").update(JSON.stringify([
    ["task","backlog",null,null],
  ])).digest("hex");
  const r=rig("succeeded","idle",{lastHandledSignature:legacy,lastWakeAt:1});
  r.setIssues("backlog");
  assert.equal((await r.watcher.pollOnce()).state,"settling");
  r.advance(300002);
  assert.equal((await r.watcher.pollOnce()).state,"woken");
  assert.equal(r.wakes(),1);
});

test("blocked successful CTO run may explore independent work once, never loop", async () => {
  const r=rig();
  r.setLiveness("blocked");
  r.setIssuesData([
    {id:"task",companyId:"company",status:"in_review",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"human_reviewer",ref:"owner"}]}},
    {id:"independent",status:"todo",assigneeAgentId:"cto"},
    {id:"parent",status:"blocked",assigneeAgentId:"cto"},
  ]);
  assert.equal((await r.watcher.pollOnce()).state,"settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce()).state,"woken");
  r.advance(600000);
  assert.equal((await r.watcher.pollOnce()).state,"already_handled");
  assert.equal(r.wakes(),1);
});

test("CTO's same-run WAITING_FOR_HUMAN handoff vetoes even an apparent ready task", async () => {
  const r=rig();
  r.setLiveness("blocked");
  r.setRunIssue("task");
  r.setComments([{id:"comment",authorAgentId:"cto",createdByRunId:"run",
    body:"WATCHER: WAITING_FOR_HUMAN"}]);
  r.setIssuesData([
    {id:"task",companyId:"company",status:"in_progress",assigneeAgentId:"cto"},
    {id:"human",companyId:"company",status:"in_review",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"human_reviewer",ref:"owner"}]}},
  ]);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
  r.advance(600000);
  assert.equal((await r.watcher.pollOnce()).state,"waiting_for_human");
  assert.equal(r.wakes(),0);
});

test("an older or foreign handoff cannot suppress a new CTO run", async () => {
  const r=rig();
  r.setLiveness("blocked");
  r.setRunIssue("task");
  r.setComments([{id:"comment",authorAgentId:"other",createdByRunId:"run",
    body:"WATCHER: WAITING_FOR_HUMAN"}]);
  r.setIssues("in_progress");
  assert.equal((await r.watcher.pollOnce()).state,"settling");
});

test("quota exhausted/unknown suppress new wake; recovery permits one resume without retries", async () => {
  const r=rig("failed");
  r.setRunError("provider_quota");
  r.setIssues("todo");
  const status=(availability: "exhausted"|"available"|"unknown",recoveryEpoch=0)=>
    ({availability,recoveryEpoch,reason:"test"});
  assert.equal((await r.watcher.pollOnce(status("exhausted"))).state,"quota_exhausted");
  assert.equal((await r.watcher.pollOnce(status("unknown"))).state,"quota_unknown");
  assert.equal((await r.watcher.pollOnce(status("available",1))).state,"settling");
  r.advance(60000);
  assert.equal((await r.watcher.pollOnce(status("available",1))).state,"woken");
  r.advance(600000);
  assert.equal((await r.watcher.pollOnce(status("available",1))).state,"already_handled");
  assert.equal(r.wakes(),1);
});

test("quota recovery does not wake a CTO when only a human review is outstanding", async () => {
  const r=rig();
  r.setIssuesData([{
    id:"task",companyId:"company",status:"in_review",assigneeAgentId:"cto",
    reviewAttention:{state:"covered",paths:[{kind:"human_reviewer",ref:"owner"}]},
  }]);
  const report={availability:"available" as const,recoveryEpoch:12,reason:"backend_allows_usage"};
  assert.equal((await r.watcher.pollOnce(report)).state,"waiting_for_human");
  r.advance(600000);
  assert.equal((await r.watcher.pollOnce(report)).state,"waiting_for_human");
  assert.equal(r.wakes(),0);
});
