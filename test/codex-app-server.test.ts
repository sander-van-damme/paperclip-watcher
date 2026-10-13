import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexQuotaProbeError, readLocalCodexQuota } from "../src/codex-quota.js";

type Mode = "success" | "initialize_rejected" | "rate_limits_rejected" | "early_exit" | "timeout";

function fakeAppServer(mode: Mode): string {
  return [
    "#!/usr/bin/env node",
    "const mode = " + JSON.stringify(mode) + ";",
    "let pending = ''; let stage = 0;",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('end', () => { if (stage < 4) process.exit(50); });",
    "process.stdin.on('data', chunk => {",
    "  pending += chunk; let pos;",
    "  while ((pos = pending.indexOf('\\n')) >= 0) {",
    "    const line = pending.slice(0, pos); pending = pending.slice(pos + 1);",
    "    const msg = JSON.parse(line);",
    "    if (msg.method === 'initialize') {",
    "      if (stage !== 0) process.exit(51); stage = 1;",
    "      if (mode === 'early_exit') process.exit(0);",
    "      setTimeout(() => {",
    "        if (stage !== 1) process.exit(52);",
    "        stage = 2;",
    "        if (mode === 'initialize_rejected') {",
    "          process.stdout.write(JSON.stringify({ id:1, error:{code:-32600,message:'DO-NOT-DISCLOSE-secret'} }) + '\\n');",
    "        } else {",
    "          process.stdout.write(JSON.stringify({ id:1, result:{serverInfo:{name:'Codex',version:'1.0'}} }) + '\\n');",
    "        }",
    "      }, 25);",
    "    } else if (msg.method === 'initialized') {",
    "      if (stage !== 2) process.exit(53); stage = 3;",
    "    } else if (msg.method === 'account/rateLimits/read') {",
    "      if (stage !== 3) process.exit(54); stage = 4;",
    "      if (mode === 'timeout') continue;",
    "      if (mode === 'rate_limits_rejected') {",
    "        process.stdout.write(JSON.stringify({ id:2, error:{code:-32600,message:'DO-NOT-DISCLOSE-secret'} }) + '\\n');",
    "      } else {",
    "        process.stdout.write(JSON.stringify({id:2,result:{ordinaryUsageAllowed:true,accountId:'expected',rateLimits:{primary:{usedPercent:23},secondary:{usedPercent:45}},rateLimitsByLimitId:{codex:{primary:{usedPercent:23},secondary:{usedPercent:45}}}}}) + '\\n');",
    "      }",
    "    } else process.exit(55);",
    "  }",
    "});",
    "",
  ].join("\n");
}
async function withFakeCodex<T>(mode: Mode, action: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-codex-handshake-"));
  try {
    const executable = join(dir, "codex");
    await writeFile(executable, fakeAppServer(mode), { mode: 0o700 });
    return await action(executable);
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
}
test("waits for initialize response before sending initialized/rate-limit RPC; stdin stays open", async () => {
  await withFakeCodex("success", async executable => {
    const result = await readLocalCodexQuota(executable, "expected", 3000);
    assert.equal(result.availability, "available");
    assert.equal(result.reason, "backend_allows_usage");
  });
});
for (const [mode, code] of [
  ["initialize_rejected", "initialize_rejected"],
  ["rate_limits_rejected", "rate_limits_rejected"],
  ["early_exit", "connection_closed"],
  ["timeout", "timeout"],
] as const) {
  test("Codex local probe reports safe diagnostic: " + mode, async () => {
    await withFakeCodex(mode, async executable => {
      await assert.rejects(
        readLocalCodexQuota(executable, "expected", mode === "timeout" ? 180 : 3000),
        (err: unknown) => {
          assert.ok(err instanceof CodexQuotaProbeError);
          assert.equal(err.code, code);
          assert.ok(!err.message.includes("DO-NOT-DISCLOSE"));
          return true;
        },
      );
    });
  });
}
test("missing Codex binary is distinguished from authentication and protocol errors", async () => {
  await assert.rejects(
    readLocalCodexQuota("/this/directory/does-not-exist/codex", undefined, 1000),
    (err: unknown) => {
      assert.ok(err instanceof CodexQuotaProbeError);
      assert.equal(err.code, "binary_not_found");
      return true;
    },
  );
});
