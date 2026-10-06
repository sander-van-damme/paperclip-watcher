# paperclip-watcher

A small external supervisor for Paperclip. It watches Paperclip's built-in **Blocked attention** signal and turns a verified `missing_disposition` recovery into a separate task assigned to a configured CEO agent.

The source task keeps its existing assignee. The CEO receives a recovery task, not ownership of the original task.

## Why this exists

A sub-agent can finish useful work but fail to perform its final control-plane action because of model quality, context compaction, tool failure, or an early stop. Requiring the same agent to remember one final `curl` command has the same failure mode.

Paperclip already detects this condition as `missing_disposition`. This watcher makes the handoff independent of the sub-agent:

```text
sub-agent run ends
      ↓
Paperclip reports missing_disposition
      ↓
paperclip-watcher verifies the active recovery
      ↓
create idempotent recovery task assigned to CEO
      ↓
Paperclip's normal assignment flow wakes CEO
      ↓
CEO inspects source task/recovery and chooses disposition
```

The watcher intentionally does **not** call `POST /api/agents/:id/wakeup` with the subordinate's source issue. Paperclip's run-dispatch policy treats a generic run on another agent's issue as stale unless that agent is an authorized recovery owner/reviewer. A separate CEO-owned recovery task uses Paperclip's normal ownership and wake semantics instead.

## Requirements

- Linux with systemd
- Node.js 20.6+
- npm
- A Paperclip bearer credential that can:
  - read company blocked-attention issues;
  - read issue recovery actions;
  - create issues and assign them to the CEO.
- The CEO agent UUID

A board/operator credential is the safest watcher credential. If you use an agent credential, it must have Paperclip's task-assignment authority.

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

`PAPERCLIP_COMPANY_ID` is optional. When omitted, the watcher calls `GET /api/agents/:id` once and uses the CEO agent's `companyId`.

The API URL is the Paperclip server root; do **not** append `/api`.

### Optional settings

```dotenv
PAPERCLIP_WATCHER_POLL_INTERVAL_MS=15000
PAPERCLIP_WATCHER_REQUEST_TIMEOUT_MS=10000
PAPERCLIP_WATCHER_PAGE_SIZE=100
PAPERCLIP_WATCHER_DRY_RUN=true
```

Dry-run mode detects and verifies missing dispositions without creating CEO recovery tasks.

## Test locally

```bash
npm run check
npm run dev
```

## Support export and download UI

The watcher can create a full Paperclip debugging bundle with the database, run logs, sanitized configuration, diagnostics, and text-based storage files.

Create one from the shell:

```bash
npm run export
```

The generated archive is written to `.paperclip-exports/` when run manually. Under the systemd service it defaults to `/var/lib/paperclip-watcher/exports`.

While the watcher is running, open:

```text
http://127.0.0.1:18787/
```

The HTML page can create new exports and download existing `.tar.gz` bundles. The HTTP interface is intentionally loopback-only. For a remote server, use an SSH tunnel instead of exposing the endpoint publicly:

```bash
ssh -L 18787:127.0.0.1:18787 your-server
```

### What is exported

- a Paperclip SQL database backup;
- Paperclip run/server logs;
- sanitized Paperclip configuration;
- watcher journal output and Paperclip diagnostics;
- text-based files from Paperclip storage;
- a storage manifest and export manifest.

The exporter **preserves database rows** rather than dropping secret tables. Known secret-bearing columns (for example secret material, OAuth/session tokens, passwords, provider credentials, proposal ciphertext, and private transfer state) are replaced with `[REDACTED]` or a redacted JSON placeholder. Logs, config, and text storage are also scrubbed for known environment secret values and common credential formats.

Binary storage files are listed in the manifest but omitted because arbitrary binary content cannot be reliably scrubbed without risking secret leakage. Environment files are included only as sanitized copies. The Paperclip secrets master key is represented by a placeholder file; the real key is never included.

Redaction is defense-in-depth: arbitrary user-authored text can contain credentials in formats the scrubber cannot recognize. Review a bundle before sharing it outside a trusted debugging context.

Optional settings:

```dotenv
PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED=true
PAPERCLIP_WATCHER_EXPORT_HTTP_HOST=127.0.0.1
PAPERCLIP_WATCHER_EXPORT_HTTP_PORT=18787
PAPERCLIP_WATCHER_EXPORT_KEEP=5
# PAPERCLIP_WATCHER_EXPORT_DIR=/path/to/exports
```

## Install as a systemd service

Run this as your normal Linux user, **not** with `sudo` in front. The installer invokes `sudo` only for operations that need root privileges:

```bash
npm run install-service
```

This command:

1. compiles the TypeScript project;
2. verifies the generated unit with `systemd-analyze verify`;
3. copies `.env` to `/etc/paperclip-watcher.env` with mode `0600`;
4. installs `/etc/systemd/system/paperclip-watcher.service`;
5. enables the service for boot;
6. starts/restarts it immediately.

The service itself runs as the user who invoked the installer, not as root.

Useful commands:

```bash
npm run service:status
npm run service:logs
sudoedit /etc/paperclip-watcher.env
sudo systemctl restart paperclip-watcher
```

Re-run `npm run install-service` after pulling a newer watcher version so `dist/` and the unit are refreshed.

## Paperclip API behavior verified by the watcher

### 1. Find blocked-attention issues

The watcher uses:

```text
GET /api/companies/:companyId/issues?attention=blocked&limit=N&offset=N
```

Paperclip's blocked-attention service uses its own canonical activity ordering and explicitly rejects `sortField=id`, `afterId`, and ascending ordering for this view. The watcher therefore uses offset pagination only.

Candidates must report either:

- `blockedInboxAttention.state === "missing_disposition"`, or
- `blockedInboxAttention.reason === "missing_successful_run_disposition"`.

### 2. Revalidate the recovery

Before escalating:

```text
GET /api/issues/:issueId/recovery-actions
```

The watcher requires the current active action to still have `kind === "missing_disposition"`. Paperclip revalidates the active recovery on this read, so stale attention records are ignored.

### 3. Create the CEO recovery task

The watcher uses:

```text
POST /api/companies/:companyId/issues
```

with the CEO as `assigneeAgentId`, a full recovery brief in the description, and:

```text
idempotencyKey = paperclip-watcher:missing-disposition:<recoveryActionId>
allowDuplicate = true
```

Paperclip's normal issue-create path queues an assignment wake for the assigned CEO. The idempotency key makes service restarts safe; `allowDuplicate=true` prevents two distinct recovery episodes from being merged merely because their titles are similar.

### 4. CEO authority on the source recovery

The recovery task does not reassign the source task. Paperclip's recovery-resolution path permits the source assignee, the recovery owner, or an agent with the management override `tasks:manage_active_checkouts` to resolve another agent's recovery. This matches a CEO/manager-above-sub-agent setup.

## Recursion safeguard

Watcher-created tasks start with:

```text
[Paperclip Watcher Recovery]
```

If one of those recovery tasks itself ends with a missing disposition, the watcher does not create another nested recovery task indefinitely. It logs a warning and leaves Paperclip's normal board attention in place.

## Scope

The watcher intentionally does not:

- change source issue ownership;
- mark source tasks done/blocked/in-review itself;
- resolve source recovery actions itself;
- infer LLM liveness independently of Paperclip;
- maintain a local database.

Its only job is to turn Paperclip's verified missing-disposition recovery into one durable, idempotent CEO recovery task.
