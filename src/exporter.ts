import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|DATABASE_URL)$/i;
const SENSITIVE_OBJECT_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|passwd|credential|private[_-]?key|connection[_-]?string|database[_-]?url|ciphertext|material)$/i;
const SENSITIVE_DB_COLUMNS = new Set([
  "api_key",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "password",
  "passwd",
  "credential",
  "credentials",
  "private_key",
  "client_secret",
  "connection_string",
  "database_url",
  "value_ciphertext",
  "material",
]);
const SENSITIVE_DB_TABLE_COLUMNS = new Map<string, Set<string>>([
  ["company_secret_versions", new Set(["material"])],
  ["company_secret_proposals", new Set(["value_ciphertext"])],
  ["company_secret_provider_configs", new Set(["config"])],
  ["chat_teams_file_transfers", new Set(["private_state"])],
  ["verification", new Set(["value"])],
]);
const JSON_REDACTION = JSON.stringify({ redacted: true, source: "paperclip-watcher-export" });

const TEXT_EXTENSIONS = new Set([
  ".log", ".txt", ".json", ".jsonl", ".ndjson", ".md", ".csv", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".html", ".xml", ".sql", ".js", ".ts", ".mjs", ".cjs",
]);

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

interface CopyContext {
  table: string;
  columns: string[];
  redactIndexes: Map<number, "json" | "text">;
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
  const defaultOutputDir = process.env.PAPERCLIP_WATCHER_STATE_DIR?.trim()
    || (process.env.INVOCATION_ID ? "/var/lib/paperclip-watcher/exports" : join(process.cwd(), ".paperclip-exports"));

  return {
    outputDir: resolve(process.env.PAPERCLIP_WATCHER_EXPORT_DIR?.trim() || defaultOutputDir),
    keep: positiveIntEnv("PAPERCLIP_WATCHER_EXPORT_KEEP", 5),
    paperclipCli: process.env.PAPERCLIP_CLI_BIN?.trim() || "paperclipai",
    paperclipHome,
    instanceId,
    configPath,
  };
}

function sensitiveEnvValues(): Array<{ name: string; value: string }> {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      SENSITIVE_ENV_NAME.test(name) && typeof value === "string" && value.length >= 6
    )
    .map(([name, value]) => ({ name, value: value! }))
    .sort((a, b) => b.value.length - a.value.length);
}

export function redactText(input: string): string {
  let text = input;
  for (const { name, value } of sensitiveEnvValues()) {
    text = text.split(value).join(`[REDACTED_${name}]`);
  }

  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:postgres(?:ql)?|mysql|mariadb):\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|private[_-]?key|database[_-]?url)\b["']?\s*[:=]\s*["']?)([^"',\s}\]]{6,})/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_OBJECT_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

export function sanitizeJson(value: unknown): unknown {
  return sanitizeValue(value);
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
      resolvePromise({
        command,
        args,
        code,
        stdout: redactText(stdout),
        stderr: redactText(stderr),
      });
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

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed;
}

function parseCopyHeader(line: string): CopyContext | null {
  const match = line.match(/^COPY\s+(.+?)\s*\((.+)\)\s+FROM\s+stdin;$/i);
  if (!match) return null;

  const qualified = match[1]!.trim();
  const table = unquoteIdentifier(qualified.split(".").at(-1)!);
  const columns = match[2]!.split(",").map((column) => unquoteIdentifier(column));
  const tableColumns = SENSITIVE_DB_TABLE_COLUMNS.get(table);
  const redactIndexes = new Map<number, "json" | "text">();

  columns.forEach((column, index) => {
    if (tableColumns?.has(column)) {
      redactIndexes.set(index, ["material", "value_ciphertext", "config", "private_state"].includes(column) ? "json" : "text");
      return;
    }
    if (SENSITIVE_DB_COLUMNS.has(column)) {
      redactIndexes.set(index, ["material", "value_ciphertext"].includes(column) ? "json" : "text");
    }
  });

  return { table, columns, redactIndexes };
}

function redactCopyRow(line: string, context: CopyContext): string {
  const fields = line.split("\t");
  for (const [index, kind] of context.redactIndexes) {
    if (index >= fields.length || fields[index] === "\\N") continue;
    fields[index] = kind === "json" ? JSON_REDACTION : "[REDACTED]";
  }
  return fields.map((field, index) =>
    context.redactIndexes.has(index) ? field : redactText(field)
  ).join("\t");
}

function splitSqlValues(input: string): string[] | null {
  const values: string[] = [];
  let start = 0;
  let index = 0;
  let dollarTag: string | null = null;
  let singleQuoted = false;

  while (index < input.length) {
    if (dollarTag) {
      if (input.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      index += 1;
      continue;
    }

    const char = input[index]!;
    if (singleQuoted) {
      if (char === "'" && input[index + 1] === "'") {
        index += 2;
        continue;
      }
      if (char === "'") singleQuoted = false;
      index += 1;
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      index += 1;
      continue;
    }

    if (char === "$") {
      const rest = input.slice(index);
      const match = rest.match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length;
        continue;
      }
    }

    if (char === ",") {
      values.push(input.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }

  if (dollarTag || singleQuoted) return null;
  values.push(input.slice(start).trim());
  return values;
}

function redactInsertStatement(line: string): string {
  const match = line.match(/^INSERT\s+INTO\s+(.+?)\s*\((.+)\)\s+VALUES\s*\((.*)\);$/i);
  if (!match) return redactText(line);

  const qualified = match[1]!.trim();
  const table = unquoteIdentifier(qualified.split(".").at(-1)!);
  const columns = match[2]!.split(",").map((column) => unquoteIdentifier(column));
  const values = splitSqlValues(match[3]!);
  if (!values || values.length !== columns.length) return redactText(line);

  const tableColumns = SENSITIVE_DB_TABLE_COLUMNS.get(table);
  columns.forEach((column, index) => {
    if (values[index] === undefined || /^NULL$/i.test(values[index]!)) return;
    const tableSensitive = tableColumns?.has(column) ?? false;
    const genericSensitive = SENSITIVE_DB_COLUMNS.has(column);
    if (!tableSensitive && !genericSensitive) {
      values[index] = redactText(values[index]!);
      return;
    }

    const json = ["material", "value_ciphertext", "config", "private_state"].includes(column);
    values[index] = json
      ? `'${JSON_REDACTION.replaceAll("'", "''")}'`
      : "'[REDACTED]'";
  });

  return `INSERT INTO ${qualified} (${match[2]!}) VALUES (${values.join(", ")});`;
}

export async function sanitizeDatabaseBackup(inputPath: string, outputPath: string): Promise<void> {
  const raw = createReadStream(inputPath);
  const input = inputPath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const gzip = createGzip();
  const output = createWriteStream(outputPath, { mode: 0o600 });
  gzip.pipe(output);

  let copyContext: CopyContext | null = null;
  try {
    for await (const line of reader) {
      if (copyContext) {
        if (line === "\\.") {
          copyContext = null;
          if (!gzip.write("\\.\n")) await once(gzip, "drain");
          continue;
        }
        if (!gzip.write(`${redactCopyRow(line, copyContext)}\n`)) await once(gzip, "drain");
        continue;
      }

      const nextContext = parseCopyHeader(line);
      if (nextContext) {
        copyContext = nextContext;
        if (!gzip.write(`${redactText(line)}\n`)) await once(gzip, "drain");
        continue;
      }

      const sanitized = /^INSERT\s+INTO\s+/i.test(line) ? redactInsertStatement(line) : redactText(line);
      if (!gzip.write(`${sanitized}\n`)) await once(gzip, "drain");
    }

    gzip.end();
    await once(output, "close");
  } finally {
    reader.close();
    input.destroy();
    raw.destroy();
  }
}

async function looksText(path: string): Promise<boolean> {
  if (TEXT_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const buffer = await readFile(path);
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

async function copySanitizedTree(
  source: string,
  destination: string,
  omitted: string[],
  relative = "",
): Promise<void> {
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch {
    return;
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });

  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const relativePath = join(relative, entry.name);

    if (entry.isSymbolicLink()) {
      omitted.push(`${relativePath} (symlink; not followed)`);
      continue;
    }
    if (entry.isDirectory()) {
      await copySanitizedTree(sourcePath, destinationPath, omitted, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      omitted.push(`${relativePath} (special file)`);
      continue;
    }

    const info = await stat(sourcePath);
    if (info.size > 128 * 1024 * 1024) {
      omitted.push(`${relativePath} (file >128 MiB)`);
      continue;
    }
    if (!(await looksText(sourcePath))) {
      omitted.push(`${relativePath} (binary; cannot safely redact)`);
      continue;
    }

    const value = await readFile(sourcePath, "utf8");
    await writeFile(destinationPath, redactText(value), { mode: 0o600 });
  }
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
        rows.push({ path: relativePath, type: "non-regular-file" });
      }
    }
  }

  await walk(storageRoot, "");
  return rows;
}

async function createDatabaseExport(settings: ExportSettings, workDir: string): Promise<void> {
  const rawDir = join(workDir, ".raw-db");
  const outputDir = join(workDir, "database");
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const result = await runCommand(settings.paperclipCli, [
    "db:backup",
    "--config", settings.configPath,
    "--dir", rawDir,
    "--retention-days", "1",
    "--filename-prefix", "paperclip-debug-raw",
    "--json",
  ], 10 * 60_000);
  await writeCommandResult(join(outputDir, "backup-command.json"), result);
  if (result.code !== 0) {
    throw new Error(`Paperclip database backup failed (exit ${result.code ?? "unknown"}): ${result.stderr || result.stdout}`);
  }

  const backups = (await readdir(rawDir)).filter((name) => name.endsWith(".sql.gz")).sort();
  const rawName = backups.at(-1);
  if (!rawName) throw new Error("Paperclip database backup completed but no .sql.gz file was produced.");

  await sanitizeDatabaseBackup(
    join(rawDir, rawName),
    join(outputDir, "paperclip-sanitized.sql.gz"),
  );
  await rm(rawDir, { recursive: true, force: true });
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
        JSON.stringify({ error: redactText(error instanceof Error ? error.message : String(error)) }, null, 2),
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
  const omitted: string[] = [];
  const instanceRoot = dirname(settings.configPath);

  try {
    await createDatabaseExport(settings, workDir);

    const paperclipDir = join(workDir, "paperclip");
    await mkdir(paperclipDir, { recursive: true, mode: 0o700 });

    try {
      const rawConfig = JSON.parse(await readFile(settings.configPath, "utf8")) as unknown;
      await writeFile(
        join(paperclipDir, "config.sanitized.json"),
        JSON.stringify(sanitizeJson(rawConfig), null, 2),
        { mode: 0o600 },
      );
    } catch (error) {
      await writeFile(
        join(paperclipDir, "config-error.txt"),
        redactText(error instanceof Error ? error.message : String(error)),
        { mode: 0o600 },
      );
    }

    await copySanitizedTree(join(instanceRoot, "logs"), join(paperclipDir, "logs"), omitted, "logs");
    await copySanitizedTree(join(instanceRoot, "data", "storage"), join(paperclipDir, "storage"), omitted, "storage");
    await writeFile(
      join(paperclipDir, "storage-manifest.json"),
      JSON.stringify(await storageManifest(join(instanceRoot, "data", "storage")), null, 2),
      { mode: 0o600 },
    );

    await bestEffortDiagnostics(settings, workDir);

    const manifest = {
      format: "paperclip-watcher-support-bundle-v1",
      generatedAt: new Date().toISOString(),
      host: { platform: platform(), release: release(), node: process.version },
      paperclip: { instanceId: settings.instanceId, configPath: settings.configPath },
      sanitization: {
        databaseRowsPreserved: true,
        knownSecretColumnsRedacted: true,
        configAndTextFilesRedacted: true,
        environmentSecretValuesRedactedWhenKnown: true,
        envFilesIncluded: false,
        secretKeyFilesIncluded: false,
        binaryFilesIncluded: false,
      },
      omitted,
      notes: [
        "The database dump preserves rows and schema but redacts known secret-bearing columns.",
        "Text logs/config/storage files are retained with credential-pattern and environment-value redaction.",
        "Binary files are omitted because arbitrary binary data cannot be safely redacted.",
        "Redaction is defense-in-depth and cannot prove that arbitrary user-authored prose never contains a credential.",
      ],
    };
    await writeFile(join(workDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const fileName = `paperclip-support-${stamp()}.tar.gz`;
    const finalPath = join(settings.outputDir, fileName);
    const tarResult = await runCommand("tar", ["-C", workDir, "-czf", finalPath, "."], 10 * 60_000);
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
