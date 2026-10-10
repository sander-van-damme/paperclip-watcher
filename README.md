# paperclip-watcher

A conservative **CTO idle supervisor** for Paperclip, plus the existing support exporter.

## What triggers a CTO wake?

The service observes the CTO's assigned Paperclip issues and recent heartbeat runs. It wakes the CTO only after an observed transition from outstanding assigned work to *all assigned issues closed* (status `done` or `cancelled`), if no CTO run is queued, running or scheduled for retry. An outstanding issue in `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, or an unknown status **prevents** a wake.

The latest CTO run must have `succeeded`; failed, interrupted, timed-out, cancelled or blocked runs do not trigger automatic retries. Rate-limited pending/retrying tasks should therefore not cause wake loops. The agent itself must be `active` or `idle`. The service does **not** independently parse provider rate-limit logs.

The check repeats every 15 seconds (configurable). The closed-task state must remain stable for 60 seconds, with a five-minute cooldown between wakes. A state file records handled issue signatures and wake timestamps across service restarts; on first start with only terminal tasks, it establishes a baseline without triggering. If the watcher was offline for the whole task lifecycle, it may miss the transition. Paperclip's existing hourly timer can remain as a fallback.

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

The exporter remains available via `npm run export` or the browser interface on port 18787. The interface uses **HTTP Basic authentication**: enter any username and the password from `PAPERCLIP_WATCHER_EXPORT_PASSWORD` (12+ characters). It binds to **127.0.0.1** by default. Access remotely with `ssh -L 18787:127.0.0.1:18787 USER@SERVER`, then browse to `http://127.0.0.1:18787/`. Do not expose this Basic-auth interface over unencrypted HTTP on a LAN. To disable the browser interface, set `PAPERCLIP_WATCHER_EXPORT_HTTP_ENABLED=false`.

The exporter includes database backups, raw logs/configuration, storage and diagnostics. Exports may contain **secrets and private data**; only the Paperclip master key is deliberately omitted. The process-environment snapshot masks common secret-like names; this is **not full sanitization**.

## API

- `GET /api/agents/:ctoId`
- `GET /api/companies/:companyId/issues?assigneeAgentId=:ctoId&sortField=id&sortDir=asc&limit=N&afterId=...`
- `GET /api/companies/:companyId/heartbeat-runs?agentId=:ctoId&limit=200`
- `POST /api/agents/:ctoId/wakeup`

The watcher does not mark issues done or modify Paperclip's queues.
