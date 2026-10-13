# paperclip-watcher

A conservative **CTO idle supervisor**, automatic **CEO Task Watchdog coverage**, and support exporter for Paperclip.

## What triggers a CTO wake?

The service observes the CTO's assigned Paperclip issues and recent heartbeat runs. It wakes the CTO when **no actionable CTO work is outstanding**, and no CTO run is queued, running or scheduled for retry. `todo`, `in_progress` and `blocked` always prevent an idle heartbeat.

`backlog` is intentionally parked work with no immediate execution expectation and **does not block** a CTO wake. `in_review` is allowed only when Paperclip explicitly identifies the next step as human-owned (a human reviewer, human execution-stage participant, human-addressed/policy-limited interaction or pending formal approval). For agent-owned, ambiguous, or stalled reviews, the watcher still waits.

When all assigned work is `done` or `cancelled`, there is one wake per changed snapshot. A newly parked backlog can allow **one** research continuation after the idle grace period. A genuine human-only review does **not** trigger another wake on its own. An unchanged task snapshot never causes repeated five-minute wakes. When a CTO run reports a blocker but other actionable tasks remain, the watcher can make one bounded continuation attempt per changed snapshot. A verified same-run `WATCHER: WAITING_FOR_HUMAN` handoff suppresses that attempt. Unknown issue statuses fail closed.

The latest CTO run must normally have `succeeded`. A successful but human-blocked run is not a provider failure; a changed snapshot with independent work may receive one bounded continuation. Failed/interrupted/timed-out/cancelled runs still do not trigger normal automatic retries. Confirmed `provider_quota` failures can recover **once** when the optional local Codex quota monitor verifies included usage is available and no native Paperclip retry is queued. Rate-limited pending/retrying tasks do not cause extra wake loops. The agent itself must be `active` or `idle`. The service does **not** independently parse provider rate-limit logs.

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

## Owner notifications via Pushover (opt-in)

The watcher now supports **Pushover notifications** for new human-owned `in_review` paths on CTO-assigned Paperclip issues. Notifications are deduplicated across restarts. An open question uses Paperclip's native interaction and `wake_assignee` behavior; **tapping** the Pushover push opens the right Paperclip issue so the owner can answer in the browser. Pushover itself is not a reply channel.

The owner already has Cloudflare Tunnel at **https://shapedisplay.sandervandamme.net**. Protect that hostname with **Cloudflare Access**, restricted to the owner. The allowed-hostname setting on Paperclip is not authentication. A browser login through Access may be necessary. Never expose Paperclip's trusted local admin mode without this boundary.

In the private server-side `.env` (never GitHub) set:

```ini
PAPERCLIP_WATCHER_PUSHOVER_TOKEN=your-pushover-application-api-token
PAPERCLIP_WATCHER_PUSHOVER_USER=your-pushover-user-key
PAPERCLIP_WATCHER_PUSHOVER_PAPERCLIP_URL=https://shapedisplay.sandervandamme.net
# Optional if several Paperclip board users share an instance:
# PAPERCLIP_WATCHER_PUSHOVER_USER_ID=your-exact-paperclip-user-id
```

Run `npm run pushover:test` for one real notification, then `npm run check` and
`npm run install-service` to update the systemd deployment. The Pushover push
has normal priority and deep-links to `/LAB/issues/LAB-...`. The notifier uses
Paperclip's verified human-owned review paths; it does not notify for unstructured
comments, generic statuses, or arbitrary agent questions.

## Local Codex quota monitor (opt-in; no model turns)

Codex's **local App Server** supplies personal used percentages, quota windows,
and backend permission via `account/rateLimits/read`. The watcher invokes
`codex app-server` via read-only JSON-RPC every 10 minutes by default, under
the same Linux user and Codex login as the Paperclip CTO. No model generation,
API key, credit redemption, or public reset predictor is involved.
`codex-resets.com` cannot confirm the quota on your account and is not
needed for the first reliable implementation.

Add these settings to the server-side private `.env`:

```ini
PAPERCLIP_WATCHER_CODEX_QUOTA_ENABLED=true
# Optional, if `codex` isn't on systemd's PATH:
# PAPERCLIP_WATCHER_CODEX_BIN=/absolute/path/to/codex
# Optional account pin to fail closed on mismatched Codex accounts:
# PAPERCLIP_WATCHER_CODEX_ACCOUNT_ID=the-known-codex-account-id
PAPERCLIP_WATCHER_CODEX_QUOTA_INTERVAL_MS=600000
```

Run `npm run quota:check`: it prints only `availability` and a short reason,
not credentials.
The local quota probe follows Codex's sequential JSON-RPC handshake and keeps
stdin open until it receives `account/rateLimits/read`. On errors the CLI emits
a **safe failure category**, never raw app-server responses or private auth data.
Examples: `binary_not_found` (check `command -v codex` or set
`PAPERCLIP_WATCHER_CODEX_BIN`), `initialize_rejected` (check Codex CLI version),
`rate_limits_rejected` (check `codex login status`), and `connection_closed`
(check that `codex app-server` starts correctly). Always first run the probe as
the same Linux user/account that executes CTO Codex.

After updating from GitHub, run `npm run quota:check` **before** restarting the
watcher with `PAPERCLIP_WATCHER_CODEX_QUOTA_ENABLED=true`. An unresolved probe
failure means quota is unknown; to avoid suspending independent work, set
`PAPERCLIP_WATCHER_CODEX_QUOTA_ENABLED=false` until the probe works.
 A returned `unknown` is **not** proof of a reset. The
watcher **never** initiates additional wakes on an unknown or exhausted quota;
ordinary Paperclip scheduled retries are preserved. A confirmed exhausted →
available transition is persisted and permits at most one new wake per
unchanged eligible work snapshot. It does not wake work waiting only on a person.

## Simple CTO handoff

When genuine human input is required, the CTO creates a saved native Paperclip
interaction, leaves the owning task `in_review`, and can continue independent,
valuable research on other tasks. At the end of the **same CTO run's issue
comment**, optionally include exactly one of these lines:

```text
WATCHER: READY
WATCHER: WAITING_FOR_HUMAN
```

`READY` requires a concrete independent next action described in that comment.
`WAITING_FOR_HUMAN` means the CTO found **no** useful independent work after
surveying its assigned work. The watcher only honors this marker from a
verified CTO-authored comment linked to the latest run. The native Paperclip
statuses and the actual human interaction remain authoritative.

The watcher conservatively allows at most one extra wake when a blocked
successful run still has independently actionable work, and otherwise
deduplicates by task snapshot and quota recovery epoch. It never creates
tasks or changes issue statuses. Active/retrying native Paperclip runs win.

## Deployment and validation

1. Install Pushover settings and (optionally) enable Codex quota in the **private
   server-side** `.env`; never commit or paste tokens.
2. Ensure `codex app-server` is accessible with the CTO's authenticated Linux
   user: `npm run quota:check` if quota monitor enabled.
3. Check your Cloudflare Access policy, then `npm run pushover:test` and click
   the notification's Paperclip URL on your phone.
4. Run `npm run check`; reinstall/restart systemd with `npm run install-service`.
   Verify `npm run service:status` and `npm run service:logs`.
5. Verify a real pending human question triggers **one** push and no repeated
   CTO wake while unanswered. Check recovery on a later quota reset.

Changing the GitHub CTO prompt does **not** automatically update the running
Paperclip CTO unless its short live instructions actually load the current
repository prompt. Verify this linkage before depending on the handoff marker.
