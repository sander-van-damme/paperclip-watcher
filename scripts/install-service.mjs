import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const envPath = join(projectDir, ".env");
const distPath = join(projectDir, "dist", "index.js");
const serviceTemplatePath = join(projectDir, "systemd", "paperclip-watcher.service");

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (process.platform !== "linux") fail("systemd installation is only supported on Linux.");
if (!existsSync(envPath)) {
  fail("Missing .env. Copy .env.example to .env, configure Paperclip, then run npm run install-service again.");
}
if (!existsSync(distPath)) fail("dist/index.js is missing. npm run install-service should build it automatically.");
if (!existsSync(serviceTemplatePath)) fail("systemd/paperclip-watcher.service is missing.");

const envText = readFileSync(envPath, "utf8");
for (const name of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_CEO_AGENT_ID"]) {
  const match = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
  const value = match?.[1]?.replace(/^['\"]|['\"]$/g, "").trim();
  if (!value || value === "replace-me" || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    fail(`Configure ${name} in .env before installing the service.`);
  }
}

const serviceUser = process.env.SUDO_USER || process.env.USER || userInfo().username;
if (!serviceUser || serviceUser === "root") {
  fail("Run npm run install-service as the normal user that should own the watcher. The installer invokes sudo itself.");
}

const systemdQuote = (value) => `"${value.replace(/([\\"])/g, "\\$1")}"`;
const service = readFileSync(serviceTemplatePath, "utf8")
  .replaceAll("@@USER@@", serviceUser)
  .replaceAll("@@WORKING_DIRECTORY@@", systemdQuote(projectDir))
  .replaceAll("@@NODE@@", systemdQuote(process.execPath))
  .replaceAll("@@ENTRYPOINT@@", systemdQuote(distPath));

const tempDir = mkdtempSync(join(tmpdir(), "paperclip-watcher-"));
const tempService = join(tempDir, "paperclip-watcher.service");
writeFileSync(tempService, service, { mode: 0o644 });

function sudo(...args) {
  execFileSync("sudo", args, { stdio: "inherit" });
}

try {
  console.log(`Installing service for user ${serviceUser}...`);
  sudo("install", "-m", "0644", tempService, "/etc/systemd/system/paperclip-watcher.service");
  sudo("install", "-m", "0600", envPath, "/etc/paperclip-watcher.env");
  sudo("systemctl", "daemon-reload");
  sudo("systemctl", "enable", "paperclip-watcher.service");
  sudo("systemctl", "restart", "paperclip-watcher.service");
  console.log("\nInstalled and started paperclip-watcher.service.");
  console.log("Status:  npm run service:status");
  console.log("Logs:    npm run service:logs");
  console.log("Config:  sudoedit /etc/paperclip-watcher.env");
  console.log("After changing /etc/paperclip-watcher.env: sudo systemctl restart paperclip-watcher");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
