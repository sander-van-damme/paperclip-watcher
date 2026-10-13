import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig().pushover;
  if (!config) throw new Error("Set PAPERCLIP_WATCHER_PUSHOVER_TOKEN and USER in private .env first");
  const values = new URLSearchParams({
    token:config.token,user:config.user,
    title:"Shape Display - Pushover test",
    message:"Testmelding van paperclip-watcher. Een vraag wordt later via de taaklink geopend.",
    url:config.baseUrl,
    url_title:"Open Paperclip",
    priority:"0",
  });
  const response = await fetch("https://api.pushover.net/1/messages.json",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:values,signal:AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Pushover returned HTTP "+response.status);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("status" in payload) || payload.status !== 1) {
    throw new Error("Pushover did not acknowledge test");
  }
  console.log("Testmelding door Pushover aanvaard; controleer je smartphone en Paperclip-link.");
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Pushover test failed");
  process.exitCode=1;
});
