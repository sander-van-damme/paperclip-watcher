# paperclip-watcher

A conservative **CTO idle supervisor**, automatic **CEO Task Watchdog coverage**, and support exporter for Paperclip.

## What triggers a CTO wake?

The service observes the CTO's assigned Paperclip issues and recent heartbeat runs. It wakes the CTO when **no actionable CTO work is outstanding**, and no CTO run is queued, running or scheduled for retry. `todo`, `in_progress` and `blocked` always prevent an idle heartbeat.

`backlog` is intentionally parked work with no immediate execution expectation and **does not block** a CTO wake. `in_review` is allowed only when Paperclip explicitly identifies the next step as human-owned (a human reviewer, human execution-stage participant, human-addressed/policy-limited interaction or pending formal approval). For agent-owned, ambiguous, or stalled reviews, the watcher still waits.

When all assigned work is `done` or `cancelled`, there is one wake per changed snapshot. While there is parked backlog or verified human-owned review work, the watcher can request **another** heartbeat after the five-minute cooldown so the CTO can research something else instead of waiting on people. This is not a 15-second wake loop; the last successful run must still satisfy all guards. Unknown issue statuses fail closed.

The latest CTO run must have `succeeded`; failed, interrupted, timed-out, cancelled or blocked runs do not trigger automatic retries. Rate-limited pending/retrying tasks should therefore not cause wake loops. The agent itself must be `active` or `idle`. The service does **not** independently parse provider rate-limit logs.

The check repeats every 15 seconds (configurable). An eligible idle state must remain stable for 60 seconds, with a five-minute cooldown between wakes. A state file records handled issue signatures and wake timestamps across service restarts. On first start, even when the CTO's assigned tasks were already terminal, the watcher may request **one** wake after the idle grace period, provided every other safety gate passes. Already-handled snapshots are not woken again after service restarts. Old watcher state files that recorded a terminal baseline without a wake are automatically eligible for this one-time catch-up. State changes are logged once (including reasons why a wake is suppressed), rather than on every poll. Paperclip's existing hourly timer can remain as a fallback.

## Automatic CEO Task Watchdog coverage

Paperclip has its own [Task Watchdog](https://github.com/paperclipai/paperclip/blob/main/doc/TASK-WATCHDOG.md) mechanism: it watches a task and its descendants for a stopped subtree, then creates a bounded review task and wakes an independent reviewer. The external watcher only *attaches* that native watchdog. It never repairs dependencies, reassigns CTO tasks or wakes the CEO directly.

Task Watchdog coverage is **always enabled**, without an environment-variable switch. After startup the service scans existing and new nonterminal CTO task trees and attaches Paperclip's native watchdog to any uncovered tree, at most once per tree. Any enable/disable line left over from an older deployment can be removed from `/etc/paperclip-watcher.env`. The watcher discovers the unique company CEO agent automatically. If there is more than one, specify `PAPERCLIP_CEO_AGENT_ID`. Both agents must be in the same company and callable. A CTO or CEO already in the `running` state can still have watchdog coverage configured; registration never starts another agent execution.

Coverage rules:

- Cover **all nonterminal CTO-assigned tasks** (`backlog`, `todo`, `in_progress`, `in_review`, `blocked`) whether standalone or part of a campaign, including already-open tasks on startup.
- Attach **at most one watchdog per task subtree**. A nonterminal CTO ancestor is the preferred watched root; a task under a different agent's parent can have its own watchdog unless an ancestor is already watched. Descendants of Paperclip watchdog review tasks are excluded, avoiding feedback loops.
- Existing watchdogs with any agent or custom instructions are preserved. The watcher remembers both existing and installed watchdogs on disk, so if one is subsequently disabled, the watcher does not restore it.
- No watchdog is attached to `done` or `cancelled` tasks. Paperclip itself decides whether the subtree is actually stopped, examining queued/running/retrying work and formal waits.
- At most **one new watchdog is attached per scan**, with scans every **60 seconds** by default. This throttles initial backfill to avoid a surge of CEO work.
- `PAPERCLIP_WATCHER_DRY_RUN=true` previews candidates without installing any watchdog.

Configuration:

| Environment variable | Default |
| --- | --- |
| `PAPERCLIP_CEO_AGENT_ID` | Auto-discover unique CEO |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_SCAN_INTERVAL_MS` | `60000` |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_MAX_ATTACHMENTS_PER_POLL` | `1` (maximum `20`) |
| `PAPERCLIP_WATCHER_TASK_WATCHDOG_INSTRUCTIONS` | Safe, evidence-first mandate |

The always-on coverage supervisor logs `CEO task watchdog attached` and `CTO task watchdog coverage`. A `agent_running` CTO idle-supervisor state is normal while the CTO is executing; it suppresses redundant CTO wakes without preventing task-watchdog registration. Its own recovery remains limited to the existing CTO idle logic; Paperclip owns stopped-tree reviews. **Wake on Demand** must be enabled for CEO and CTO. Their periodic timer heartbeats can remain off.

**Important limits:** Paperclip's `GET /issues/:id/watchdog` returns only an *active* watchdog. If someone disabled a watchdog **before this supervisor ever saw it**, it cannot distinguish that from a never-configured task and may attach a fresh one during its first scan. There is also a small concurrent-edit race because Paperclip exposes an upsert but no create-if-absent request; the watcher double-checks before writing, but that is not atomic. Existing tracked manual disablement is honored.

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

The exporter remains available via `npm run export` or the browser interface on **port 18787**. AI Relay uses port **8787**, so their default ports do not conflict. The browser interface now **binds to `0.0.0.0` by default**, making it reachable from the LAN at `http://<server-lan-ip>:18787/`. Enter any username and the password from `PAPERCLIP_WATCHER_EXPORT_PASSWORD` for HTTP Basic authentication.

To update an **existing** systemd deployment after `git pull`, update both the repository's `.env` and the installed `/etc/paperclip-watcher.env` to contain `PAPERCLIP_WATCHER_EXPORT_BIND_HOST=0.0.0.0`. Existing explicit `127.0.0.1` values override the new source default, and `npm run install-service` copies `.env` over the installed environment file. Restart the service with `sudo systemctl restart paperclip-watcher.service`, check `sudo ss -ltnp | grep ':18787'`, and open `http://<server-lan-ip>:18787/` from another LAN device. If the server runs a firewall, allow TCP/18787 only from the trusted LAN subnet. To restrict the interface back to loopback, set `PAPERCLIP_WATCHER_EXPORT_BIND_HOST=127.0.0.1`.

**Security:** This interface uses HTTP (not HTTPS), so Basic-auth passwords and downloaded database archives are **unencrypted on the network**. Use only on a trusted, access-controlled LAN, never forward TCP/18787 through the router, and never expose it to the public internet. `0.0.0.0` listens on all IPv4 interfaces; it does not itself restrict access to the LAN. For encrypted access, keep the exporter on loopback and use an SSH tunnel (`ssh -L 18787:127.0.0.1:18787 USER@SERVER`) or an HTTPS reverse proxy. To disable the browser interface, set `PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED=false`.

The exporter includes database backups, raw logs/configuration, storage and diagnostics. Exports may contain **secrets and private data**; only the Paperclip master key is deliberately omitted. The process-environment snapshot masks common secret-like names; this is **not full sanitization**.

## API

- `GET /api/agents/:ctoId`
- `GET /api/companies/:companyId/issues?assigneeAgentId=:ctoId&sortField=id&sortDir=asc&limit=N&afterId=...`
- `GET /api/companies/:companyId/heartbeat-runs?agentId=:ctoId&limit=200`
- `POST /api/agents/:ctoId/wakeup`
- `GET /api/companies/:companyId/agents` (CEO autodiscovery)
- `GET /api/issues/:issueId` (parent coverage and human execution-stage review checks)
- `GET /api/issues/:issueId/interactions` (verify pending human review audience)
- `GET /api/issues/:issueId/watchdog` (existing coverage)
- `PUT /api/issues/:issueId/watchdog` (one-time CEO attachment)

The watcher does not mark issues done or modify Paperclip's queues.

## Inspect blocked CTO wakeups

The `outstanding_issues` log reports `assignedCount` (all CTO-assigned tasks) separately from `outstandingCount` (tasks that are actionable, blocked, or have unresolved/agent-owned reviews). A `parkedBacklogCount` and `humanReviewCount` describe safe waits that do not block. `outstandingIssues` includes each blocking issue's LAB identifier, title and status, up to 30 entries; `omittedOutstandingCount` reports any remaining blockers. Changes to that list produce a new log entry, even when the state name stays the same.

To see the complete current list in the Paperclip CLI, run `paperclipai issue list --company-id COMPANY_UUID --assignee-agent-id CTO_UUID --status backlog,todo,in_progress,in_review,blocked`. A blocked parent campaign assigned to the CTO is a blocker even if its children have finished.
