import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  createExportBundle,
  exportPathForDownload,
  listExports,
  resolveExportSettings,
  type ExportInfo,
} from "./exporter.js";
import { log } from "./logger.js";

interface ExportState {
  running: boolean;
  startedAt: string | null;
  lastCompleted: ExportInfo | null;
  lastError: string | null;
}

function html(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Paperclip Support Exports</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { margin-bottom: 8px; }
    .muted { opacity: .72; }
    .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 14px; padding: 18px; margin-top: 20px; }
    button, a.download { border: 1px solid currentColor; border-radius: 9px; padding: 9px 13px; background: transparent; color: inherit; text-decoration: none; cursor: pointer; }
    button:disabled { opacity: .5; cursor: wait; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px 8px; border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
    th { border-top: 0; }
    code { font-size: .92em; }
    .error { color: #d33; white-space: pre-wrap; }
    .status { min-height: 1.4em; }
  </style>
</head>
<body>
  <h1>Paperclip Support Exports</h1>
  <p class="muted">Create a full debugging bundle with Paperclip database, logs, configuration, diagnostics and text storage. Known credentials are replaced with <code>[REDACTED]</code>.</p>

  <div class="card">
    <button id="create">Create new export</button>
    <p id="status" class="status muted"></p>
    <p id="error" class="error"></p>
  </div>

  <div class="card">
    <h2>Available exports</h2>
    <table>
      <thead><tr><th>Created</th><th>Size</th><th></th></tr></thead>
      <tbody id="exports"><tr><td colspan="3" class="muted">Loading…</td></tr></tbody>
    </table>
  </div>

<script>
const createButton = document.getElementById("create");
const status = document.getElementById("status");
const error = document.getElementById("error");
const tbody = document.getElementById("exports");

function size(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i++) { value /= 1024; unit = units[i]; }
  return (unit === "B" ? value : value.toFixed(1)) + " " + unit;
}

async function refresh() {
  const response = await fetch("/api/exports", { cache: "no-store" });
  const body = await response.json();
  createButton.disabled = body.running;
  status.textContent = body.running
    ? "Export running since " + new Date(body.startedAt).toLocaleString()
    : body.lastCompleted
      ? "Last export completed " + new Date(body.lastCompleted.createdAt).toLocaleString()
      : "";
  error.textContent = body.lastError || "";

  tbody.replaceChildren();
  if (!body.exports.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="3" class="muted">No exports yet.</td>';
    tbody.append(tr);
  } else {
    for (const item of body.exports) {
      const tr = document.createElement("tr");
      const created = document.createElement("td");
      created.textContent = new Date(item.createdAt).toLocaleString();
      const bytes = document.createElement("td");
      bytes.textContent = size(item.sizeBytes);
      const action = document.createElement("td");
      const link = document.createElement("a");
      link.className = "download";
      link.href = "/exports/" + encodeURIComponent(item.fileName);
      link.textContent = "Download";
      action.append(link);
      tr.append(created, bytes, action);
      tbody.append(tr);
    }
  }
}

createButton.addEventListener("click", async () => {
  error.textContent = "";
  createButton.disabled = true;
  const response = await fetch("/api/exports", {
    method: "POST",
    headers: { "X-Paperclip-Export-Action": "create" },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    error.textContent = body.error || "Failed to start export.";
  }
  await refresh();
});

setInterval(refresh, 2500);
refresh().catch((err) => { error.textContent = String(err); });
</script>
</body>
</html>`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function httpPort(): number {
  const raw = process.env.PAPERCLIP_WATCHER_EXPORT_HTTP_PORT?.trim();
  if (!raw) return 8787;
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PAPERCLIP_WATCHER_EXPORT_HTTP_PORT must be between 1 and 65535");
  }
  return port;
}

export async function startExportHttpServer(): Promise<Server> {
  const enabled = (process.env.PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED?.trim().toLowerCase() ?? "true") !== "false";
  if (!enabled) throw new Error("Export HTTP server is disabled");

  const host = process.env.PAPERCLIP_WATCHER_EXPORT_HTTP_HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("Export HTTP server only supports loopback hosts; use an SSH tunnel for remote access.");
  }
  const port = httpPort();
  const settings = resolveExportSettings();
  const state: ExportState = {
    running: false,
    startedAt: null,
    lastCompleted: null,
    lastError: null,
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/") {
        const body = html();
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(body);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/exports") {
        json(response, 200, {
          ...state,
          exports: await listExports(settings),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/exports") {
        if (request.headers["x-paperclip-export-action"] !== "create") {
          json(response, 400, { error: "Missing export action header." });
          return;
        }
        if (state.running) {
          json(response, 409, { error: "An export is already running." });
          return;
        }

        state.running = true;
        state.startedAt = new Date().toISOString();
        state.lastError = null;

        void createExportBundle(settings)
          .then((result) => {
            state.lastCompleted = result;
            log("info", "Paperclip support export completed", {
              fileName: result.fileName,
              sizeBytes: result.sizeBytes,
            });
          })
          .catch((cause) => {
            state.lastError = cause instanceof Error ? cause.message : String(cause);
            log("error", "Paperclip support export failed", { error: state.lastError });
          })
          .finally(() => {
            state.running = false;
            state.startedAt = null;
          });

        json(response, 202, { accepted: true });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/exports/")) {
        const fileName = decodeURIComponent(url.pathname.slice("/exports/".length));
        const path = await exportPathForDownload(fileName, settings);
        if (!path) {
          json(response, 404, { error: "Export not found." });
          return;
        }
        const info = await stat(path);
        response.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Length": info.size,
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        createReadStream(path).pipe(response);
        return;
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise());
  });
  log("info", "Paperclip support export UI started", {
    url: `http://${host}:${port}/`,
    outputDir: settings.outputDir,
  });
  return server;
}
