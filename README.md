# paperclip-watcher

A tiny external supervisor for Paperclip. It watches Paperclip's existing **Blocked attention** signal and escalates `missing_disposition` recoveries to a configured CEO agent.

The watcher does **not** reassign the source issue. The CEO is only woken to inspect the issue/recovery evidence and choose the correct disposition.

## Why this exists

A sub-agent can finish useful work but fail to perform its final control-plane action (for example because of model quality, compaction, or tool failure). Requiring that same agent to remember a final `curl` call has the same failure mode.

Paperclip already detects this condition as `missing_disposition`. This service makes the escalation independent of the sub-agent:

```text
sub-agent run ends
      ↓
Paperclip reports missing_disposition
      ↓
paperclip-watcher
      ↓
wake CEO agent (idempotently)
      ↓
CEO inspects recovery and chooses disposition
```

## Requirements

- Linux with systemd
- Node.js 20.6+
- npm
- A Paperclip bearer credential that can:
  - read company issues / recovery actions
  - wake the configured CEO agent
- The CEO agent UUID

## Configure

```bash
npm install
cp .env.example .env
nano .env
```

Required values:

```dotenv
PAPERCLIP_API_URL=http://127.0.0.1:3100
PAPERCLIP_API_KEY=...
PAPERCLIP_CEO_AGENT_ID=...
```

`PAPERCLIP_COMPANY_ID` is optional. When omitted, the watcher fetches the CEO agent once and uses its `companyId`.

The API URL is the Paperclip server root; do **not** append `/api`.

### Optional settings

```dotenv
PAPERCLIP_WATCHER_POLL_INTERVAL_MS=15000
PAPERCLIP_WATCHER_REQUEST_TIMEOUT_MS=10000
PAPERCLIP_WATCHER_PAGE_SIZE=100
PAPERCLIP_WATCHER_DRY_RUN=true
```

Dry-run mode detects and logs missing dispositions without waking the CEO.

## Test locally

```bash
npm run check
npm run dev
```

## Install as a systemd service

Run this as your normal Linux user, **not** with `sudo` in front. The installer invokes `sudo` only for the operations that need root privileges:

```bash
npm run install-service
```

This command:

1. compiles the TypeScript project;
2. copies `.env` to `/etc/paperclip-watcher.env` with mode `0600`;
3. installs `/etc/systemd/system/paperclip-watcher.service`;
4. enables the service for boot;
5. starts/restarts it immediately.

The service itself runs as the user who invoked the installer, not as root.

Useful commands:

```bash
npm run service:status
npm run service:logs
sudoedit /etc/paperclip-watcher.env
sudo systemctl restart paperclip-watcher
```

Re-run `npm run install-service` after pulling a newer watcher version so `dist/` and the unit are refreshed.

## How detection works

Each poll requests:

```text
GET /api/companies/:companyId/issues
    ?attention=blocked
    &includeBlockedInboxAttention=true
```

Only issues with either:

- `blockedInboxAttention.state === "missing_disposition"`, or
- `blockedInboxAttention.reason === "missing_successful_run_disposition"`

are candidates.

Before escalating, the watcher verifies:

```text
GET /api/issues/:issueId/recovery-actions
```

and requires the active recovery action to still have `kind === "missing_disposition"`. This avoids acting on stale attention data.

The CEO wakeup uses:

```text
POST /api/agents/:ceoAgentId/wakeup
```

with a stable Paperclip idempotency key:

```text
paperclip-watcher:missing-disposition:<recoveryActionId>
```

That means polling and service restarts do not require a local database for deduplication. Paperclip remains the source of truth.

## Scope

The watcher intentionally does not:

- change issue ownership;
- mark tasks done/blocked/in-review itself;
- resolve recovery actions itself;
- infer liveness independently of Paperclip;
- store API state locally.

Its only job is to notice Paperclip's missing-disposition recovery and reliably bring the CEO agent into the loop.
