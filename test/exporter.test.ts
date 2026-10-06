import assert from "node:assert/strict";
import test from "node:test";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  redactText,
  sanitizeDatabaseBackup,
  sanitizeJson,
} from "../src/exporter.js";

test("redactText removes common credentials while preserving surrounding logs", () => {
  const old = process.env.TEST_API_KEY;
  process.env.TEST_API_KEY = "super-secret-value-123";
  try {
    const value = redactText(
      "before Bearer abcdefghijklmnopqrstuvwxyz after super-secret-value-123 github_pat_abcdefghijklmnop",
    );
    assert.match(value, /before/);
    assert.match(value, /after/);
    assert.doesNotMatch(value, /super-secret-value-123/);
    assert.doesNotMatch(value, /abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(value, /github_pat_abcdefghijklmnop/);
  } finally {
    if (old === undefined) delete process.env.TEST_API_KEY;
    else process.env.TEST_API_KEY = old;
  }
});

test("sanitizeJson redacts sensitive values without removing object structure", () => {
  assert.deepEqual(sanitizeJson({
    provider: "openai",
    apiKey: "secret-value",
    nested: {
      token: "token-value",
      model: "gpt-test",
    },
  }), {
    provider: "openai",
    apiKey: "[REDACTED]",
    nested: {
      token: "[REDACTED]",
      model: "gpt-test",
    },
  });
});

test("database sanitizer preserves secret rows and redacts secret-bearing columns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-watcher-export-test-"));
  const input = join(dir, "raw.sql.gz");
  const output = join(dir, "sanitized.sql.gz");
  const sql = [
    "COPY public.company_secret_versions (id, secret_id, version, material, value_sha256, status) FROM stdin;",
    'v1\ts1\t1\t{"ciphertext":"very-secret-ciphertext"}\thash123\tcurrent',
    "\\.",
    "COPY public.company_secret_provider_configs (id, company_id, provider, config, status) FROM stdin;",
    'pc1\tc1\taws\t{"accessKey":"AKIASECRET","region":"eu-west-1"}\tready',
    "\\.",
    "COPY public.heartbeat_runs (id, status, error) FROM stdin;",
    "r1\tfailed\tBearer abcdefghijklmnopqrstuvwxyz",
    "\\.",
    "",
  ].join("\n");

  try {
    const source = join(dir, "raw.sql");
    await writeFile(source, sql);
    await pipeline(createReadStream(source), createGzip(), createWriteStream(input));
    await sanitizeDatabaseBackup(input, output);

    const chunks: Buffer[] = [];
    const stream = createReadStream(output).pipe(createGunzip());
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const sanitized = Buffer.concat(chunks).toString("utf8");

    assert.match(sanitized, /v1\ts1\t1\t\{"redacted":true,"source":"paperclip-watcher-export"\}\thash123\tcurrent/);
    assert.match(sanitized, /pc1\tc1\taws\t\{"redacted":true,"source":"paperclip-watcher-export"\}\tready/);
    assert.match(sanitized, /r1\tfailed\tBearer \[REDACTED\]/);

    assert.doesNotMatch(sanitized, /very-secret-ciphertext/);
    assert.doesNotMatch(sanitized, /AKIASECRET/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
