import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ExportSettings {
  outputDir: string;
  keep: number;
  paperclipCli: string;
  paperclipHome: string;
  instanceId: string;
  configPath: string;
}

export interface ExportInfo {
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

interface CommandResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveExportSettings(): ExportSettings {
  const instanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  const paperclipHome = resolve(process.env.PAPERCLIP_HOME?.trim() || join(homedir(), ".paperclip"));
  const configPath = resolve(
    process.env.PAPERCLIP_CONFIG?.trim()
      || join(paperclipHome, "instances", instanceId, "config.json"),
  );
  const stateRoot = process.env.PAPERCLIP_WATCHER_STATE_DIR?.trim()
    || process.env.STATE_DIRECTORY?.split(":")[0]?.trim();
  const defaultOutputDir = stateRoot
    ? join(stateRoot, "exports")
    : join(process.cwd(), ".paperclip-exports");

  return {
    outputDir: resolve(process.env.PAPERCLIP_WATCHER_EXPORT_DIR?.trim() || defaultOutputDir),
    keep: positiveIntEnv("PAPERCLIP_WATCHER_EXPORT_KEEP", 5),
    paperclipCli:
      process.env.PAPERCLIP_WATCHER_RESOLVED_CLI_BIN?.trim()
      || process.env.PAPERCLIP_CLI_BIN?.trim()
      || "paperclipai",
    paperclipHome,
    instanceId,
    configPath,
  };
}

async function runCommand(command: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const maxBytes = 16 * 1024 * 1024;
    const append = (current: string, chunk: Buffer | string) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next) <= maxBytes) return next;
      return Buffer.from(next).subarray(-maxBytes).toString("utf8");
    };

    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ command, args, code, stdout, stderr });
    });
  });
}

async function writeCommandResult(path: string, result: CommandResult): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      command: [result.command, ...result.args],
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    }, null, 2),
    { mode: 0o600 },
  );
}

async function copyIfExists(source: string, destination: string): Promise<boolean> {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await cp(source, destination, { recursive: true, force: true, preserveTimestamps: true });
  return true;
}

async function storageManifest(storageRoot: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];

  async function walk(dir: string, relative: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      const relativePath = join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(path, relativePath);
      } else if (entry.isFile()) {
        const info = await stat(path);
        rows.push({ path: relativePath, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
      } else {
        rows.push({ path: relativePath, type: entry.isSymbolicLink() ? "symlink" : "non-regular-file" });
      }
    }
  }

  await walk(storageRoot, "");
  return rows;
}

async function createDatabaseExport(settings: ExportSettings, workDir: string): Promise<void> {
  const stagingDir = join(workDir, ".db-staging");
  const outputDir = join(workDir, "database");
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const result = await runCommand(settings.paperclipCli, [
    "db:backup",
    "--config", settings.configPath,
    "--dir", stagingDir,
    "--retention-days", "1",
    "--filename-prefix", "paperclip-debug",
    "--json",
  ], 10 * 60_000);
  await writeCommandResult(join(outputDir, "backup-command.json"), result);
  if (result.code !== 0) {
    throw new Error(`Paperclip database backup failed (exit ${result.code ?? "unknown"}): ${result.stderr || result.stdout}`);
  }

  const backups = (await readdir(stagingDir)).filter((name) => name.endsWith(".sql.gz")).sort();
  const backupName = backups.at(-1);
  if (!backupName) throw new Error("Paperclip database backup completed but no .sql.gz file was produced.");

  await rename(
    join(stagingDir, backupName),
    join(outputDir, "paperclip.sql.gz"),
  );
  await rm(stagingDir, { recursive: true, force: true });
}

async function bestEffortDiagnostics(settings: ExportSettings, workDir: string): Promise<void> {
  const diagnosticsDir = join(workDir, "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });

  const commands: Array<{ name: string; command: string; args: string[]; timeoutMs?: number }> = [
    { name: "paperclip-version.json", command: settings.paperclipCli, args: ["--version"] },
    {
      name: "paperclip-doctor.json",
      command: settings.paperclipCli,
      args: ["doctor", "--config", settings.configPath],
      timeoutMs: 120_000,
    },
    {
      name: "watcher-journal.json",
      command: "journalctl",
      args: ["-u", "paperclip-watcher.service", "--no-pager", "-n", "10000", "--output=short-iso"],
    },
  ];

  for (const item of commands) {
    try {
      const result = await runCommand(item.command, item.args, item.timeoutMs ?? 30_000);
      await writeCommandResult(join(diagnosticsDir, item.name), result);
    } catch (error) {
      await writeFile(
        join(diagnosticsDir, item.name),
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
        { mode: 0o600 },
      );
    }
  }
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function pruneOldExports(settings: ExportSettings): Promise<void> {
  const exports = await listExports(settings);
  for (const old of exports.slice(settings.keep)) await rm(old.path, { force: true });
}

export async function createExportBundle(settings = resolveExportSettings()): Promise<ExportInfo> {
  await mkdir(settings.outputDir, { recursive: true, mode: 0o700 });
  await chmod(settings.outputDir, 0o700).catch(() => {});

  const workDir = await mkdtemp(join(tmpdir(), "paperclip-support-"));
  const instanceRoot = dirname(settings.configPath);
  const omitted: string[] = [];

  try {
    await createDatabaseExport(settings, workDir);

    const paperclipDir = join(workDir, "paperclip");
    await mkdir(paperclipDir, { recursive: true, mode: 0o700 });

    await copyIfExists(settings.configPath, join(paperclipDir, "config.json"));
    await copyIfExists(join(instanceRoot, ".env"), join(paperclipDir, ".env"));
    await copyIfExists(join(instanceRoot, "logs"), join(paperclipDir, "logs"));
    await copyIfExists(join(instanceRoot, "data", "storage"), join(paperclipDir, "storage"));

    await writeFile(
      join(paperclipDir, "process-environment.json"),
      JSON.stringify(process.env, null, 2),
      { mode: 0o600 },
    );

    const masterKeyPath = join(instanceRoot, "secrets", "master.key");
    try {
      await stat(masterKeyPath);
      omitted.push("secrets/master.key (explicitly excluded)");
      const secretsDir = join(paperclipDir, "secrets");
      await mkdir(secretsDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(secretsDir, "master.key.OMITTED.txt"),
        "Paperclip secrets master key intentionally excluded from debug exports.\n",
        { mode: 0o600 },
      );
    } catch {
      // No local master key present.
    }

    await writeFile(
      join(paperclipDir, "storage-manifest.json"),
      JSON.stringify(await storageManifest(join(instanceRoot, "data", "storage")), null, 2),
      { mode: 0o600 },
    );

    await bestEffortDiagnostics(settings, workDir);

    const manifest = {
      format: "paperclip-watcher-support-bundle-v2",
      generatedAt: new Date().toISOString(),
      host: { platform: platform(), release: release(), node: process.version },
      paperclip: { instanceId: settings.instanceId, configPath: settings.configPath },
      contents: {
        databaseBackup: "raw",
        logs: "raw",
        config: "raw",
        instanceEnvironment: "raw when present",
        processEnvironment: "raw",
        storage: "raw including binary files",
      },
      sanitization: "disabled",
      omitted,
      warning:
        "This bundle is intended for trusted local debugging and may contain credentials, tokens, private data, and other sensitive values.",
    };
    await writeFile(join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const fileName = `paperclip-support-${stamp()}.tar.gz`;
    const finalPath = join(settings.outputDir, fileName);
    const tarResult = await runCommand("tar", ["-C", workDir, "-I", "gzip -1", "-cf", finalPath, "."], 10 * 60_000);
    if (tarResult.code !== 0) throw new Error(`tar failed: ${tarResult.stderr || tarResult.stdout}`);
    await chmod(finalPath, 0o600);

    await pruneOldExports(settings);

    const info = await stat(finalPath);
    return { fileName, path: finalPath, sizeBytes: info.size, createdAt: info.mtime.toISOString() };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function listExports(settings = resolveExportSettings()): Promise<ExportInfo[]> {
  await mkdir(settings.outputDir, { recursive: true, mode: 0o700 });
  const names = await readdir(settings.outputDir);
  const exports: ExportInfo[] = [];

  for (const fileName of names) {
    if (!/^paperclip-support-[A-Za-z0-9TZ]+\.tar\.gz$/.test(fileName)) continue;
    const path = join(settings.outputDir, fileName);
    const info = await stat(path);
    if (!info.isFile()) continue;
    exports.push({ fileName, path, sizeBytes: info.size, createdAt: info.mtime.toISOString() });
  }

  return exports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function exportPathForDownload(
  fileName: string,
  settings = resolveExportSettings(),
): Promise<string | null> {
  if (basename(fileName) !== fileName || !/^paperclip-support-[A-Za-z0-9TZ]+\.tar\.gz$/.test(fileName)) {
    return null;
  }
  const path = join(settings.outputDir, fileName);
  try {
    const info = await stat(path);
    return info.isFile() ? path : null;
  } catch {
    return null;
  }
}
