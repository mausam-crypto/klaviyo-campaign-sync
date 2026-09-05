# Architecture

## Components

- **Render Cron Job** — runs `node dist/run.js` every 5 minutes. No always-on web server needed;
  each run is a short-lived, stateless invocation that reads/writes all state through Postgres.
  Chosen over a long-running Background Worker with an in-process scheduler because it's simpler
  (nothing to keep alive, nothing to restart-recover in-process — restart recovery is just "the DB
  is the source of truth, re-run picks up where it left off"). 5 minutes (not 30) because winner
  detection needs to catch each EN test's clean, pre-rollout data snapshot in a narrow window —
  see DESIGN.md §2 for why. Each run is cheap when there's nothing to do: a `GET /api/campaigns`
  check on known-pending families, and it only spends one of the Reporting API's scarce 2/min
  budget when a family has actually entered its polling window (`send_time + 0.5×duration` through
  `send_time + 1.5×duration`) — everywhere else it's a handful of ordinary `campaigns:read` calls.
- **Render Postgres** (smallest plan) — the state store: execution records, audit log, discovered
  campaign-family maps, per-language results. Chosen over SQLite-on-disk (used by
  `cellexia-order-split`) because this service's core requirement is an inspectable, durable audit
  trail of real customer-facing sends, and Postgres is trivially queryable/backed-up without
  needing to pull a disk snapshot off Render.
- **Klaviyo API client** — thin wrapper enforcing: revision header pinned to `2026-07-15`, retry
  with backoff on 429/5xx (see below), and a single choke point all write operations pass through
  so dry-run mode can intercept them.
- **Slack notifier** — posts success/failure messages (§18 of your spec) via an Incoming Webhook.
- **CLI entry points** — `run.js` (the scheduled job), plus standalone read-only commands for each
  testing phase below (`discover.js`, `compute-winner.js`, `dry-run.js`), so early phases can be
  run manually and reviewed before anything runs unattended.

## Database schema

```sql
create table campaign_group_executions (
  id                 uuid primary key default gen_random_uuid(),
  campaign_group_tag text not null,           -- e.g. "group:2026-09-03-skincare-order"
  en_campaign_id     text not null,
  status             text not null,           -- PENDING | WINNER_COMPUTED | VALIDATING |
                                                -- SCHEDULING | SUCCESS | FAILED
  winner_variation   text,                    -- 'A' | 'B', null until computed
  winner_message_id  text,
  click_rate_a       numeric, click_rate_b       numeric,
  placed_order_rate_a numeric, placed_order_rate_b numeric,
  decided_by         text,               -- 'conversion_rate' | 'click_rate_tiebreak'
  poll_window_start  timestamptz,        -- send_time + 0.5x test_duration_hours
  poll_window_end    timestamptz,        -- send_time + 1.5x test_duration_hours
  snapshot_recipients_a integer, snapshot_recipients_b integer,
  snapshot_classification text,          -- TOO_EARLY | CLEAN | CONTAMINATED, last poll's result
  poll_attempts      integer not null default 0,
  failure_reason     text,
  automation_version text not null,
  automation_enabled boolean not null,         -- snapshot of the kill switch at run time
  dry_run            boolean not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (campaign_group_tag)                  -- idempotency: one row per family, ever
);

create table language_campaign_results (
  id                uuid primary key default gen_random_uuid(),
  execution_id      uuid not null references campaign_group_executions(id),
  language_code     text not null,
  campaign_id       text,
  keep_message_id   text,      -- winning variation's message id -- what a human should keep
  delete_message_id text,      -- losing variation's message id -- what a human should delete
  validation_status text not null,             -- PASSED | FAILED
  validation_failures jsonb,                    -- list of which of the 14 checks failed, if any
  action            text not null,              -- AWAITING_MANUAL_ACTION | CONFIRMED_SENT | MISMATCH_DETECTED
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (execution_id, language_code)
);

create table campaign_exclusions (
  campaign_group_tag text primary key,          -- campaign-level kill switch, §24
  reason             text not null,
  created_at         timestamptz not null default now()
);
```

## Idempotency

Two structures, two idempotency stories (DESIGN.md §7 has the full history — briefly: no writes,
then writes were added back once the 28-campaign split was decided on 2026-09-05):

**Legacy structure** (one campaign, two messages per language — read-only reporting only, can
never reach a write): the handoff and its confirmation still need to be idempotent, since a human
acting on a duplicate Slack alert, or the automation double-confirming, is a real failure mode.
- `campaign_group_executions.campaign_group_tag` is unique — before doing anything, the run
  queries for an existing row for this family. `status = SUCCESS` → skip entirely. `status =
  AWAITING_MANUAL_ACTION` → skip winner computation and go straight to `verifyManualCompletion()`
  — the winner, once computed and notified, is never recomputed or re-notified for the same
  family. `status = FAILED` → does not auto-retry.
- `language_campaign_results` is keyed `unique (execution_id, language_code)` — the
  keep/delete-message-id decision for a language is written once and only transitions forward to
  `CONFIRMED_SENT` or `MISMATCH_DETECTED`, never recomputed.
- **Closing the loop**: every run for a family still `AWAITING_MANUAL_ACTION` re-fetches its
  language campaigns: one remaining message matching `keep_message_id` → `CONFIRMED_SENT`; one
  remaining message that doesn't match → `MISMATCH_DETECTED`, alerted once via `notifyMismatch()`,
  never re-alerted every 5 minutes. All confirmed → family `SUCCESS`, `notifyCompletion()` fires.

**Dual-campaign structure** (two single-message campaigns per language — the write path): the
same `campaign_group_executions.campaign_group_tag` uniqueness applies (`SUCCESS` → skip,
`FAILED` → no auto-retry), but there's no intermediate `AWAITING_MANUAL_ACTION` state — winner
computation, validation, and the schedule+archive writes all happen in the same run, and the
family goes straight to `SUCCESS` once they complete. **Writes here are not indiscriminately
retried** (see below) — a transport error after a write call needs the caller to check the
campaign's actual resulting state before assuming it didn't land, same principle as the
now-superseded design originally planned for this, before it was briefly designed out and back in.

## Retry / rate-limit handling

- Every Klaviyo call goes through one retry wrapper: on `429`, respect `Retry-After` if present,
  else exponential backoff (1s, 2s, 4s, 8s), capped at 4 attempts. On `5xx`, same backoff, capped
  at 3 attempts. On `4xx` other than 429, no retry.
- **Reads** (campaign list, campaign-messages, Reporting API, metrics) are safe to retry blindly —
  there's no write to double-apply.
- **Writes** (`dual_campaign`'s schedule/send-job/archive calls) are NOT blindly retried on
  ambiguous failure. If a write call times out or errors after possibly having reached Klaviyo,
  re-fetch that campaign's current state first — if it already shows the expected `send_strategy`/
  `status`/`archived` value, the original call actually succeeded despite the client-side error,
  and the retry is skipped rather than risking a duplicate schedule/send/archive action.
- The Reporting API's tight rate limit (1/s, 2/m, 225/day) means: never poll it more often than
  the 5-minute cron interval already provides headroom for, and never call it in a loop across
  many campaigns per run — one call per pending EN family per run, grouped by
  `campaign_id, campaign_message_id, variation` (all three required together — verified against
  the live API), is enough to get both variations' stats in a single request.

## Dry-run mode

`DRY_RUN=true` env var. Klaviyo writes (`dual_campaign`'s schedule/send-job/archive calls) are
intercepted by `klaviyoClient.mjs`'s write-choke-point, which logs the exact request instead of
sending it. Slack notifications and DB writes (marking a family `AWAITING_MANUAL_ACTION`/
`SUCCESS`/`FAILED`) are gated the same way, directly in `slack.mjs`/`db.mjs`. Winner computation,
validation, and all read calls still execute for real either way, so dry-run output reflects
genuine analysis of real data — it just doesn't touch Klaviyo, alert anyone, or
persist state that a later real run would need to respect.

## Kill switches

- `AUTOMATION_ENABLED=false` (global env var) — checked first, before any Klaviyo call. If false,
  the run logs `automation disabled, skipping` and exits. Read-only discovery still allowed for
  debugging (a separate `--discover-only` flag), but no computation or writes.
- `campaign_exclusions` table (per-family) — checked per family after discovery, before winner
  computation. A family with a matching row is skipped and logged, everything else in that run
  proceeds normally.

## Phased testing plan

| Phase | What it does | Writes to Klaviyo? | Success criteria |
|---|---|---|---|
| 1 | Read-only discovery against one real campaign family | No | Produces a discovery report matching real IDs/structure; no unexpected schema surprises vs API_CAPABILITY_MATRIX.md |
| 2 | Read-only winner calculation | No | Computed winner matches manual calculation from the same Reporting API data, for at least 2 historical completed tests |
| 3 | Dry-run language matching | No | All 14/28 languages correctly resolved by name; validation checklist output matches manual review |
| 4 | Dry-run full execution | No | End-to-end dry-run output reviewed and approved by you before any write path is enabled — **done**, confirmed against production Klaviyo + Postgres 2026-09-04 |
| 5 | Test against a controlled/test campaign | Yes, but only a throwaway test campaign you create for this purpose | A real schedule/send-job/archive round-trips correctly on a campaign nobody but you sees — lower-stakes than originally scoped now that `dual_campaign` campaigns are always single-message (standard Klaviyo behavior), but still worth one real dry run before trusting it on a customer-facing send |
| 6 | Enable campaign modification, not sending | Yes (PATCH only) | Content/schedule updates land correctly on a real language campaign; still requires you to manually hit "send" |
| 7 | Controlled real campaign | Yes, full write path, on one real (low-stakes) campaign family, with you watching live | Full automated flow succeeds end-to-end once, matches expected behavior |
| 8 | Production automation | Yes | Runs unattended on the cron schedule |

Each phase requires your explicit go-ahead before moving to the next — this isn't something the
automation self-promotes through.

## Deployment plan

1. Repo: `github.com/mausam-crypto/klaviyo-campaign-sync` (new), working copy at
   `cellexia-apps/klaviyo-campaign-sync/klaviyo-campaign-sync/` per your existing convention.
2. Render: one Postgres instance + one Cron Job service, both provisioned via `render.yaml`.
   `KLAVIYO_API_KEY`, `SLACK_WEBHOOK_URL`, `DATABASE_URL` as Render secret env vars — never
   committed.
3. `AUTOMATION_ENABLED=false` and `DRY_RUN=true` are the default committed values in
   `render.yaml`; flipping either to production values is a manual Render dashboard change you
   make yourself when a phase's success criteria are met, not something a deploy silently changes.

## Monitoring / alerting

- Every run (including "nothing to do") writes a heartbeat row so a missed-cron-trigger is
  detectable (alert if no heartbeat in > 2x the cron interval).
- Slack notification on every `SUCCESS` and `FAILED` terminal state (§18 format), and on any
  stuck-state alert (§2 of DESIGN.md).
- No alert fatigue by design: a family sitting in `PENDING` because its 24h test window hasn't
  elapsed yet is not alert-worthy and doesn't notify.

## Security

- `KLAVIYO_API_KEY` and `SLACK_WEBHOOK_URL` live only in Render's env var store. Never logged —
  the retry/error-logging wrapper explicitly redacts the `Authorization` header and webhook URL
  from any logged request/error object.
- Scopes: `campaigns:read`, `metrics:read`, `campaigns:write` (needed as of 2026-09-05's final
  design — the 28-campaign split schedules/archives real campaigns; an earlier design briefly had
  the automation never write to Klaviyo at all, which would have made this permanently
  unnecessary, but that was reversed — see DESIGN.md §7). `tags:read` is no longer needed since
  family/language identification is name-based, not tag-based. Klaviyo doesn't allow adding scopes
  to an existing key, so the original read-only Phase 1 key needs replacing, not editing.
- `.env` stays gitignored; `.env.example` ships with empty placeholders only.
