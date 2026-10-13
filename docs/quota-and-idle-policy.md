# Quota-aware CTO continuation: implementation design

Status: **initial implementation and automated fixtures in PR #12; not deployed to the Odroid.** The owner must check the account mapping, Cloudflare Access, and a real Pushover push before production use. No personal auth tokens, full support bundles or private prompts in git.

## Observed failure (operator's 2026-10-13 support export)

- 2026-10-12 21:20 UTC: CTO run `succeeded` with `livenessState=blocked`,
  `livenessReason="Run output declared a concrete blocker"`. Its task LAB-388
  was legitimately waiting on a physical-access question.
- The external watcher then recorded `last_run_not_successful` and stopped
  autonomous wakes, even though **run status had succeeded** and independent
  research may have remained. Activity resumed following human answers on
  2026-10-13 15:27 UTC.
- In the sampled runs, 59 CTO runs had `errorCode=provider_quota`; 38 had
  `scheduledRetryAt`. On 2026-10-12 00:52 UTC a provider message suggested an
  Oct 18 reset, while a manual successful CTO run occurred at 07:20 UTC the
  same day. The evidence cannot explain *why* quota became available.
- Existing `backlog` and verified human-only `in_review` states may currently
  lead to another idle wake every five minutes even without a changed
  work opportunity. Prevent repeating such wakes against an unchanged snapshot.

These observations come from the operator's private export; do not commit it.

## Separate deterministic concerns

1. **Attention notifier:** alert the owner about new actionable human interactions
   and approvals. Deduplicate by interaction/decision ID, not by human-readable
   question text. Do not wake the CTO as a side effect of sending a push. Continue
   to prefer native Paperclip `wake_assignee` when an answer arrives.
2. **Quota monitor:** a lightweight, independent, **read-only** Codex status
   probe, no model turn, no ChatGPT credit redemption. Run under the same
   Codex home/account used by Paperclip's CTO. Use `codex app-server` stdio
   protocol: `initialize`, `initialized`, then `account/rateLimits/read`.
   Read `rateLimitsByLimitId` where available, plus the legacy `rateLimits`
   field; select the relevant shared Codex quota conservatively. Interpret
   `usedPercent`, `windowDurationMins`, `resetsAt` and
   `rateLimitReachedType`; do not assume primary means five-hour or that
   every account exposes both windows. Unknown/missing or stale data is not
   evidence of quota recovery.
3. **Work scheduler:** never equate *one blocked issue or blocked latest run*
   with the entire CTO research portfolio being blocked. Evaluate live runs,
   scheduled native Paperclip retries, assignee, task dependencies, true
   pending human paths, and available independent work before a wake.

## CTO structured handoff

At the end of an ordinary, successful run, the CTO should report a compact
machine-readable disposition in its existing Paperclip task handoff, without
creating a special monitoring task. Candidates:

- `next_work_ready`: at least one specific independent task ID and concrete
  next action, with the related decision/input dependencies recorded.
- `waiting_human_only`: specific pending interaction IDs; the CTO reviewed
  its other eligible work and found no *currently useful* independent task.
- `waiting_quota`: execution interrupted by confirmed provider quota.
- `complete`: work is finished; no action needed.
- `unknown`: do not infer an all-clear from loose English log prose.

The implemented handoff is deliberately small: a line `WATCHER: READY` or `WATCHER: WAITING_FOR_HUMAN` in a Paperclip issue comment, attributed to the CTO and to the latest successful run. The code checks the run-linked comment before honoring the marker. Without a verifiable marker it falls back to conservative task/run status. This is a planning hint, never authority to bypass an approval or create duplicate campaigns.

The CTO should not create a new task merely to claim work exists. A new
independent task must have a decision-relevant objective and expected output.
Protect the current main research priority and do not duplicate active campaigns.

## Trigger/wake policy

- Detect new meaningful events: new eligible task, changed dependencies, new
  or answered human interaction, a confirmed quota-unblocked transition,
  fresh operator direction, or a previously blocked independent work item
  becoming actionable. Do not use elapsed time alone to invent a campaign.
- Fingerprint event IDs and relevant task versions. Persist a one-time wake
  decision per fingerprint **before** the Paperclip wake request; handle
  uncertain network outcomes without a wake storm.
- Never wake while a CTO run is queued, running, or in an active Paperclip
  scheduled retry. Do not independently restart terminal/failed work.
- When verified `waiting_human_only` has no independently actionable work,
  notify the human and stop. A public reset announcement alone does not
  bypass this stop.
- For a new meaningful state change with ambiguous independent-work
  availability, permit **at most one** bounded CTO evaluation wake (with
  quota available). If it reports no useful independent work, stop until
  another event occurs. In particular, a latest successful run with
  `livenessState=blocked` may qualify for this bounded evaluation; it must
  not be considered a failed provider run by itself.
- Do **not** re-wake static `backlog` or human `in_review` snapshots every
  five minutes. Add a quiet upper bound to diagnostic/probe wakes even if the
  snapshots oscillate; keep the existing CEO problem watchdog separate.

## Quota transition policy

- Probe personal quota periodically (suggested 10-15 min read-only poll; shorter
  only around a known reset) and persist last sampled quotas, refresh time and
  per-window reset epoch. Never run a model as a routine quota probe.
- Use explicit `provider_quota` as exhaustion evidence, and supported
  `account/rateLimits/read` values as primary confirmation of recovery.
  A healthy 5h window cannot bypass a still-exhausted weekly window, and
  a weekly window cannot bypass another relevant model-specific bucket.
- `codex-resets.com` global-announcement feed is a *hint to refresh the
  local quota probe*. A banked reset/credit does not imply quota is usable;
  do not automatically redeem paid or earned credits or invoke
  `account/rateLimitResetCredit/consume`.
- On confirmed exhausted->available transition: wake **at most once per new
  quota epoch**, **only if** previously quota-stalled work remains eligible.
  Never wake if awaiting human input only, nothing independently valuable
  remains, or Paperclip already scheduled a retry/has an active run.
- If the app-server probe is unavailable, keep quota status `unknown` and
  record one operator-facing diagnostic (not recurring error spam). Do not
  use guessed public dates to force a wake.
- Verify the probe is using the same ChatGPT account/credentials as CTO,
  without logging or persisting raw credentials. No direct private upstream
  API calls or copied browser cookies.

## Required regression scenarios

1. `succeeded + livenessState=blocked` on a human question plus an independent
   ready work item -> one bounded wake, not permanent suppression.
2. Identical human-review/backlog snapshot for 18h -> zero repeated wakes.
3. Verified `waiting_human_only` with no independent work -> zero wakes on
   cooldown expiry, even if provider quota has become available.
4. A new human answer -> native Paperclip continuation; external watcher
   must not duplicate it. New question -> one Pushover message.
5. Weekly quota 100% used and five-hour available -> no wake.
6. Quota changes exhausted to confirmed available, runnable work exists and
   no active/scheduled run -> exactly one resume wake after restart too.
7. Public banked/global announcement with unchanged personal quota -> no wake.
8. Provider quota error with future retry, auth failure, malformed/stale quota,
   and API outage -> correct distinct handling, no storm.
9. Replayed error sequence with many `provider_quota` retries -> watcher
   adds no duplicate provider calls and logs no credential contents.
10. Unrecognized Paperclip review/dependency status -> fail closed with
    diagnostic, not an invented human-only wait.

## Rollout

Automated unit and integration fixtures cover quota windows and restart-safe recovery counters, stable backlog/human waits, blocked-run continuation, and Pushover question deduplication. Remaining real-world acceptance: install under the correct Linux/Codex account; `npm run quota:check`; `npm run pushover:test`; verify Cloudflare Access URL on phone; and verify the actual CTO prompt loads from the engineering repository. The existing Paperclip native retry policy is untouched.

Useful public contracts:
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://github.com/paperclipai/paperclip/blob/master/skills/paperclip/references/api-reference.md
