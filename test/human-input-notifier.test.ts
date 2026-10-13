import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanInputNotifier } from "../src/human-input-notifier.js";
import { PaperclipClient } from "../src/paperclip-client.js";
import type { WatcherConfig, IssueSummary } from "../src/types.js";

const cfg: WatcherConfig = {
  apiUrl:"http://paperclip.test",apiKey:"test",ctoAgentId:"cto",
  companyId:"company",pollIntervalMs:15000,requestTimeoutMs:10000,pageSize:500,
  idleGraceMs:60000,cooldownMs:300000,stateDir:"/tmp/unused",dryRun:false,
  taskWatchdogScanIntervalMs:60000,taskWatchdogMaxAttachmentsPerPoll:1,
  taskWatchdogInstructions:"review",
};
test("Pushover delivers one deep-linked message per new verified pending human question across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(),"paperclip-push-"));
  try {
    let interactionId = "question-1";
    const issue: IssueSummary = {
      id:"issue-1",identifier:"LAB-388",title:"Physical measurement question",
      status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"interaction",ref:interactionId}]},
    };
    const fakePaperclip: typeof fetch = async (url) => {
      const endpoint=new URL(String(url));
      if(endpoint.pathname.endsWith("/issues"))return Response.json([issue]);
      if(endpoint.pathname.endsWith("/issues/issue-1/interactions"))return Response.json([{
        id:interactionId,status:"pending",effectiveResolverPolicy:"human_only",
        addresseeAgentId:null,
      }]);
      throw new Error("Unexpected path "+endpoint.pathname);
    };
    const pushed: URLSearchParams[] = [];
    const fakePush: typeof fetch = async (url, init) => {
      assert.equal(String(url),"https://api.pushover.net/1/messages.json");
      pushed.push(new URLSearchParams(String(init?.body)));
      return Response.json({status:1,request:"ok"});
    };
    const config={token:"push-token",user:"push-user",baseUrl:"https://shapedisplay.sandervandamme.net"};
    const client=new PaperclipClient(cfg,fakePaperclip);
    const first=new HumanInputNotifier(client,dir,config,fakePush);
    assert.equal(await first.poll("company","cto"),1);
    assert.equal(await first.poll("company","cto"),0);
    assert.equal(pushed[0]?.get("url"),"https://shapedisplay.sandervandamme.net/LAB/issues/LAB-388");
    assert.equal(pushed[0]?.get("priority"),"0");
    const restarted=new HumanInputNotifier(client,dir,config,fakePush);
    assert.equal(await restarted.poll("company","cto"),0);
    interactionId="question-2";
    issue.reviewAttention={state:"covered",paths:[{kind:"interaction",ref:interactionId}]};
    assert.equal(await restarted.poll("company","cto"),1);
    assert.equal(pushed.length,2);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("Pushover never sends an agent-directed review as a human question", async () => {
  const dir=await mkdtemp(join(tmpdir(),"paperclip-nonhuman-"));
  try {
    const issue={id:"issue",identifier:"LAB-99",title:"Agent review",
      status:"in_review",companyId:"company",assigneeAgentId:"cto",
      reviewAttention:{state:"covered",paths:[{kind:"interaction",ref:"agent-question"}]}};
    const fake: typeof fetch=async (url)=>{
      if(String(url).includes("/issues?"))return Response.json([issue]);
      if(String(url).endsWith("/interactions"))return Response.json([{
        id:"agent-question",status:"pending",effectiveResolverPolicy:"anyone",
        addresseeAgentId:"another-agent",
      }]);
      throw new Error("Unexpected Paperclip path");
    };
    const push: typeof fetch=async()=>{throw new Error("Should not send");};
    const notifier=new HumanInputNotifier(new PaperclipClient(cfg,fake),dir,
      {token:"token",user:"user",baseUrl:"https://shapedisplay.sandervandamme.net"},push);
    assert.equal(await notifier.poll("company","cto"),0);
  } finally {await rm(dir,{recursive:true,force:true});}
});
