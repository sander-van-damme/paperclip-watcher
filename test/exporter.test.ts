import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportPathForDownload,
  listExports,
  type ExportSettings,
} from "../src/exporter.js";

function settings(outputDir: string): ExportSettings {
  return {
    outputDir,
    keep: 5,
    paperclipCli: "/usr/bin/false",
    paperclipHome: "/tmp/paperclip",
    instanceId: "default",
    configPath: "/tmp/paperclip/instances/default/config.json",
  };
}

test("listExports returns support archives newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-watcher-export-list-"));
  try {
    const first = join(dir, "paperclip-support-20261006T120000Z.tar.gz");
    const second = join(dir, "paperclip-support-20261006T130000Z.tar.gz");
    await writeFile(first, "first");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(second, "second");
    await writeFile(join(dir, "ignore.txt"), "nope");

    const exports = await listExports(settings(dir));
    assert.equal(exports.length, 2);
    assert.equal(exports[0]?.fileName, "paperclip-support-20261006T130000Z.tar.gz");
    assert.equal(exports[1]?.fileName, "paperclip-support-20261006T120000Z.tar.gz");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("exportPathForDownload only resolves valid support archive names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paperclip-watcher-export-path-"));
  try {
    const name = "paperclip-support-20261006T130000Z.tar.gz";
    const path = join(dir, name);
    await writeFile(path, "bundle");

    assert.equal(await exportPathForDownload(name, settings(dir)), path);
    assert.equal(await exportPathForDownload("../invalid", settings(dir)), null);
    assert.equal(await exportPathForDownload("other.tar.gz", settings(dir)), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
