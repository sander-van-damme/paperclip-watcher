import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCodexQuota } from "../src/codex-quota.js";

test("local app-server probe only initializes and reads quotas, no model turn", async () => {
  const dir=await mkdtemp(join(tmpdir(),"paperclip-fake-codex-"));
  const executable=join(dir,"fake-codex");
  try {
    const fake=[
      "#!/usr/bin/env node",
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', value => buffer += value);",
      "process.stdin.on('end', () => {",
      "  const messages=buffer.trim().split('\\n').map(JSON.parse);",
      "  const commands=messages.map(m=>m.method);",
      "  if (process.argv[2] !== 'app-server' || JSON.stringify(commands) !== JSON.stringify(['initialize','initialized','account/rateLimits/read'])) process.exit(11);",
      "  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}) + '\\n');",
      "  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{ordinaryUsageAllowed:true,accountId:'expected',rateLimits:{primary:{usedPercent:23},secondary:{usedPercent:45}},rateLimitsByLimitId:{codex:{primary:{usedPercent:23},secondary:{usedPercent:45}}}}}) + '\\n');",
      "});",
      "",
    ].join("\n");
    await writeFile(executable,fake,{mode:0o700});
    const result=await readLocalCodexQuota(executable,"expected",3000);
    assert.equal(result.availability,"available");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
