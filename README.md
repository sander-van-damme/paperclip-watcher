# paperclip-watcher

A conservative **CTO idle supervisor**, automatic **CEO Task Watchdog coverage**, and support exporter for Paperclip.

## What triggers a CTO wake?

The service observes the CTO's assigned Paperclip issues and recent heartbeat runs. It wakes the CTO when **no actionable CTO work is outstanding**, and no CTO run is queued, running or scheduled for retry. `todo`, `in_progress` and `blocked` always prevent an idle heartbeat.

`backlog` is intentionally parked work with no immediate execution expectation and **does not block** a CTO wake. `in_review` is allowed only when Paperclip explicitly identifies the next step as human-owned (a human reviewer, human execution-stage participant, human-addressed/policy-limited interaction or pending formal approval). For agent-owned, ambiguous, or stalled reviews, the watcher still waits.

When all assigned work is `done` or `cancelled`, there is one wake per changed snapshot. While there is parked backlog or verified human-owned review work, the watcher can request **another** heartbeat after the five-minute cooldown so the CTO can research something else instead of waiting on people. This is not a 15-second wake loop; the last successful run must still satisfy all guards. Unknown issue statuses fail closed.

The latest CTO run must have `succeeded`; failed, interrupted, timed-out, cancelled or blocked runs do not trigger automatic retries. Rate-limited pending/retrying tasks should therefore not cause wake loops. The agent itself must be `active` or `idle`. The service does **not** independently parse provider rate-limit logs.

The check repeats every 15 seconds (configurable). An eligible idle state must remain stable for 60 seconds, with a five-minute cooldown between wakes. A state file records handled issue signatures and wake timestamps across service restarts. On first start, even when the CTO's assigned tasks were already terminal, the watcher may request **one** wake after the idle grace period, provided every other safety gate passes. Already-handled snapshots are not woken again after service restarts. Old watcher state files that recorded a terminal baseline without a wake are automatically eligible for this one-time catch-up. State changes are logged once (including reasons why a wake is suppressed), rather than on every poll. Paperclip's existing hourly timer can remain as a fallback.

## Problem-triggered CEO Task Watchdogs

Paperclip's [native Task Watchdog](https://github.com/paperclipai/paperclip/blob/master/doc/TASK-WATCHDOG.md) reviews **every newly stopped task subtree**, including normally completed `done` work. Attaching it to every CTO task therefore generated needless CEO review tasks. The external watcher now **installs a native CEO watchdog only after detecting an unresolved operational problem**. This selection is always on; no enable flag is required.

Evidence accepted for a possible problem:

- An `in_review` issue with Paperclip's authoritative `reviewAttention.state = stalled` (not a legitimate agent/human review wait).
- A `blocked` issue for which Paperclip reports `blockedInboxAttention` as needing action because of a broken dependency/owner/review path. Valid human/board/external waits are not counted.
- An assigned CTO `todo` or `in_progress` issue whose **latest issue-specific CTO run** has `failed` or `timed_out`, with no active run, scheduled retry or active Paperclip recovery action. Provider quota/rate-limit failures and expected dependency/terminal-status outcomes are ignored.

The **same problem signal must persist for at least 10 minutes** across scans. A new run, retry, resolved review path, normal completion, or changed failure resets the observation window. Before each native watchdog attachment the watcher re-reads the issue and existing watchdog to avoid writes based on stale evidence. The observation window is deliberately reset when the service restarts: the safer failure mode is delayed detection rather than an unnecessary CEO wake. Logs report `detectedProblems`, `settlingProblems` and attachments. Detection is evidence-based, not merely elapsed time since a comment.

Paperclip itself handles the scoped stopped-subtree repair once attached. The external watcher does not directly wake the CEO, change task status or interfere with active runs. Its separate **CTO idle wakeup** continues independently.

**Existing watchdogs and tasks are not migrated or removed.** Native watchdogs already installed on older tasks keep their existing behavior and can still produce reviews on successful completion. Any previously installed or manually configured watchdog is left untouched; remembered manual removals are still respected. Descendants of a watched ancestor are not given another watchdog, but a healthy ancestor **without** a watchdog does not hide a truly stalled child.

Up to one new watchdog is attached per scan by default (60-second scans); configure `PAPERCLIP_WATCHER_TASK_WATCHDOG_MAX_ATTACHMENTS_PER_POLL` when necessary (maximum 20). The watcher discovers the company CEO, or uses `PAPERCLIP_CEO_AGENT_ID` when provided. Set `PAPERCLIP_WATCHER_DRY_RUN=true` to preview detection without any writes. **Wake on Demand** must be enabled for CEO and CTO. Both timer heartbeats can remain off.

**Limits:** Purely semantic errors in successfully completed research are not operational stalls and will not be detected. The Watcher also intentionally avoids escalating ambiguous waits or runs already undergoing Paperclip recovery. **Silent but still-running processes are different:** Paperclip's native task watchdog deliberately will not fire while a run is active, even if the process has stopped producing output. Those need the separate active-run silence monitor / an explicit CEO recovery workflow and are not yet fixed by this change. There is still a small concurrent-change race between the last recheck and native watchdog creation because Paperclip only offers an upsert endpoint; this cannot be made atomic by the external watcher.

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

## Pushover for owner input (opt-in)

Set `PAPERCLIP_WATCHER_PUSHOVER_TOKEN`, `PAPERCLIP_WATCHER_PUSHOVER_USER`, and
`PAPERCLIP_WATCHER_PUSHOVER_PAPERCLIP_URL` in the private `.env` file.
The URL should be reachable from the phone, e.g. through Tailscale.
Optionally set `PAPERCLIP_WATCHER_PUSHOVER_USER_ID` to restrict direct review
and interaction notifications to a particular Paperclip user. Formal approvals
without verifiable user ownership are skipped with this filter.

The service scans every 60 seconds and sends a normal-priority Pushover message
on a newly detected verified human-owned `in_review` path. The push includes
a deep link to the Paperclip issue; answering happens within Paperclip, **not**
within Pushover. Notifications are deduplicated across restarts in
`human-input-notifications.json`. This feature does not wake agents, change
tasks, or spend model tokens. It does not yet cover ad-hoc questions in comments,
or every kind of approval outside CTO-owned `in_review` issues.

Pushover secrets must remain outside Git. Use `npm run install-service`
after changing the deployed .env file, then inspect service logs. A dry-run
facility for notifications is not implemented: setting valid Pushover credentials
will send actual pushes when outstanding human reviews are found.
