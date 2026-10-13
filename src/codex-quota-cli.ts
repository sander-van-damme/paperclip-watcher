import { loadConfig } from "./config.js";
import { readLocalCodexQuota } from "./codex-quota.js";

const config=loadConfig();
if (!config.codexQuota) {
  console.error("Enable PAPERCLIP_WATCHER_CODEX_QUOTA_ENABLED=true in .env first");
  process.exitCode=1;
} else {
  readLocalCodexQuota(config.codexQuota.executable,config.codexQuota.expectedAccountId)
    .then(result => {
      console.log(JSON.stringify({availability:result.availability,reason:result.reason},null,2));
      if(result.availability==="unknown")process.exitCode=1;
    })
    .catch(() => {
      console.error("Codex app-server quota probe failed. Check the binary, same Linux user and Codex login.");
      process.exitCode=1;
    });
}
