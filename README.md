# paperclip-watcher

A conservative **CTO idle supervisor**, optional automatic **CEO Task Watchdog coverage**, and support exporter for Paperclip.

## What triggers a CTO wake?

The service observes the CTO's assigned Paperclip issues and recent heartbeat runs. It wakes the CTO only after an observed transition from outstanding assigned work to *all assigned issues closed* (status `done` or `cancelled`), if no CTO run is queued, running or scheduled for retry. An outstanding issue in `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, or an unknown status **prevents** a wake.

The latest CTO run must have `succeeded`; failed, interrupted, timed-out, cancelled or blocked runs do not trigger automatic retries. Rate-limited pending/retrying tasks should therefore not cause wake loops. The agent itself must be `active` or `idle`. The service does **not** independently parse provider rate-limit logs.

The check repeats every 15 seconds (configurable). The closed-task state must remain stable for 60 seconds, with a five-minute cooldown between wakes. A state file records handled issue signatures and wake timestamps across service restarts. On first start, even when the CTO's assigned tasks were already terminal, the watcher may request **one** wake after the idle grace period, provided every other safety gate passes. Already-handled snapshots are not woken again after service restarts. Old watcher state files that recorded a terminal baseline without a wake are automatically eligible for this one-time catch-up. State changes are logged once (including reasons why a wake is suppressed), rather than on every poll. Paperclip's existing hourly timer can remain as a fallback.

## Optional CEO Task Watchdog coverage

Paperclip has its own [Task Watchdog](https://github.com/paperclipai/paperclip/blob/main/doc/TASK-WATCHDOG.md) mechanism: it watches a task and its descendants for a stopped subtree, then creates a bounded review task and wakes an independent reviewer. The external watcher only *attaches* that native watchdog. It never repairs dependencies, reassigns CTO tasks or wakes the CEO directly.

**Opt in** by setting `PAPERCLIP_WATCHER_TASK_WATCHDOG_ENABLED=true` in the deployed environment file (`/etc/paperclip-watcher.env`), then restart the systemd service. The watcher discovers the unique company CEO agent automatically. If there is more than one, specify `PAPERCLIP_CEO_AGENT_ID`. Both agents must be in the same company and callable.

Coverage rules:

- Cover **all nonterminal CTO-assigned tasks** (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`) whether standalone or part of a campaign, including already-open tasks at opt-in time.
- Attach **at most one watchdog per task subtree**. A nonterminal CTO ancestor is the preferred watched root; a task under a different agent's parent can have its own watchdog unless an ancestor is already watched. Descendants of Paperclip watchdog review tasks are excluded, avoiding feedback loops.
- Existing watchdogs with any agent or custom instructions are preserved. The watcher remembers both existing and installed watchdogs on disk, so if one is subsequently disabled, the watcher does not restore it.
- No watchdog is attached to `done` or `cancelled` tasks. Paperclip itself decides whether the subtree is actually stopped, examining queued/running/retrying work and formal waits.
- At most **one new watchdog is attached per scan**, with scans every **60 seconds** by default. This throttles initial backfill to avoid a surge of CEO work.
- `PAPERCLIP_WATCHER_DRY_RUN=true` previews candidates without installing any watchdog.

Configuration:

| Environment variable | Default |
| --- | --- |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_ENABLED` | `false` |
| `PAPERCLIP_CEO_AGENT_ID` | Auto-discover unique CEO |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_SCAN_INTERVAL_MS` | `60000` |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_MAX_ATTACHMENTS_PER_POLL` | `1` (maximum `20`) |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_INSTRUCTIONS` | Safe, evidence-first mandate |

The watcher logs `CEO task watchdog attached` and `CTO task watchdog coverage`. Its own recovery remains limited to the existing CTO idle logic; Paperclip owns stopped-tree reviews. **Wake on Demand** must be enabled for CEO and CTO. Their periodic timer heartbeats can remain off.

**Important limits:** Paperclip's `GET /issues/:id/watchdog` returns only an *active* watchdog. If someone disabled a watchdog **before this supervisor ever saw it**, it cannot distinguish that from a never-configured task and may attach a fresh one when enabled. There is also a small concurrent-edit race because Paperclip exposes an upsert but no create-if-absent request; the watcher double-checks before writing, but that is not atomic. Existing tracked manual disablement is honored.

## Installation

Use Linux, Node.js >=20.6, npm, and a Paperclip board/operator API credential with permissions to read CTO issues/runs and wake the CTO.

```bash
npm install
cp .env.example .env
nano .env
npm run check
npm run install-service
npm run service:status
npm run service:logs
```

Configure `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_CTO_AGENT_ID`, and `PAPERCLIP_WATCHER_EXPORT_PASSWORD`. Company ID is inferred from the CTO when omitted. Set `PAPERCLIP_WATCHER_DRY_RUN=true` for a no-wakeup trial.

The systemd installer creates `/etc/paperclip-watcher.env`, installs a service and persists state under the systemd state directory. After editing deployed env values, restart the service. Re-run `npm run install-service` after pulling updates.

## Debugging exports

The exporter remains available via `npm run export` or the browser interface on port 18787. The interface uses **HTTP Basic authentication**: enter any username and the password from `PAPERCLIP_WATCHER_EXPORT_PASSWORD` (non-empty; a strong password is recommended). It binds to **127.0.0.1** by default. Access remotely with `ssh -L 18787:127.0.0.1:18787 USER@SERVER`, then browse to `http://127.0.0.1:18787/`. Do not expose this Basic-auth interface over unencrypted HTTP on a LAN. To disable the browser interface, set `PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED=false`.

The exporter includes database backups, raw logs/configuration, storage and diagnostics. Exports may contain **secrets and private data**; only the Paperclip master key is deliberately omitted. The process-environment snapshot masks common secret-like names; this is **not full sanitization**.

## API

- `GET /api/agents/:ctoId`
- `GET /api/companies/:companyId/issues?assigneeAgentId=:ctoId&sortField=id&sortDir=asc&limit=N&afterId=...`
- `GET /api/companies/:companyId/heartbeat-runs?agentId=:ctoId&limit=200`
- `POST /api/agents/:ctoId/wakeup`
- `GET /api/companies/:companyId/agents` (CEO autodiscovery)
- `GET /api/issues/:issueId` (parent coverage checks)
- `GET /api/issues/:issueId/watchdog` (existing coverage)
- `PUT /api/issues/:issueId/watchdog` (one-time CEO attachment)

The watcher does not mark issues done or modify Paperclip's queues.

## Inspect blocked CTO wakeups

The `outstanding_issues` log reports `assignedCount` (all CTO-assigned tasks) separately from `outstandingCount` (tasks that are not `done` or `cancelled`). `outstandingIssues` includes each blocking issue's LAB identifier, title and status, up to 30 entries; `omittedOutstandingCount` reports any remaining blockers. Changes to that list produce a new log entry, even when the state name stays the same.

To see the complete current list in the Paperclip CLI, run `paperclipai issue list --company-id COMPANY_UUID --assignee-agent-id CTO_UUID --status backlog,todo,in_progress,in_review,blocked`. A blocked parent campaign assigned to the CTO is a blocker even if its children have finished.
