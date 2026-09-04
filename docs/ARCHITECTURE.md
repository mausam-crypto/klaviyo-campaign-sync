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
  conversion_diff_pct numeric,
  conversion_override boolean,
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
  variation_message_id text,
  validation_status text not null,             -- PASSED | FAILED
  validation_failures jsonb,                    -- list of which of the 14 checks failed, if any
  scheduled_send_at timestamptz,
  action            text not null,              -- WOULD_SCHEDULE (dry-run) | SCHEDULED | SKIPPED
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

- `campaign_group_executions.campaign_group_tag` is unique — before doing anything, the run
  queries for an existing row for this family. If one exists with `status = SUCCESS`, the family is
  skipped entirely (logged as `already processed`, not an error). If one exists mid-flight
  (`VALIDATING`/`SCHEDULING`) from a prior run that crashed, the run resumes from that row's state
  rather than recomputing the winner from scratch — the winner, once written, is never
  recalculated for the same family.
- Per-language scheduling is itself idempotent: before calling the schedule API for a language
  campaign, check `language_campaign_results` for an existing `SCHEDULED` row for that
  `(execution_id, language_code)` pair, and separately re-check the live campaign's own `status`
  isn't already `Scheduled`/`Sending`/`Sent` (defense in depth — catches a manual scheduling done
  outside the automation too).

## Retry / rate-limit handling

- Every Klaviyo call goes through one retry wrapper: on `429`, respect `Retry-After` if present,
  else exponential backoff (1s, 2s, 4s, 8s), capped at 4 attempts. On `5xx`, same backoff, capped
  at 3 attempts. On `4xx` other than 429, no retry — that's a real error (bad request, auth,
  validation) and retrying won't help.
- **Writes that cause a real-world effect (schedule, send) are never blindly retried.** Before
  retrying a schedule/send call after a timeout or ambiguous error, the wrapper re-fetches the
  campaign's current `status` first — if it already shows `Scheduled`/`Sending`/`Sent`, the
  original call actually succeeded server-side despite the client-side error, and the retry is
  skipped (logged as `write succeeded despite transport error, not retrying`).
- The Reporting API's tight rate limit (1/s, 2/m, 225/day) means: never poll it more often than the
  30-minute cron interval already provides headroom for, and never call it in a loop across many
  campaigns per run — one call per pending EN family per run, grouped by `campaign_message_id`, is
  enough to get both variations' stats in a single request.

## Dry-run mode

`DRY_RUN=true` env var. When set, the write-choke-point in the Klaviyo client wrapper logs the
exact request it *would* have made (method, endpoint, body) and returns a synthetic success
without calling Klaviyo. All read calls (campaigns, reporting, metrics, tags) still execute for
real, so winner computation and validation run against real data. Output matches the format in
§23 of your spec. This is the default for every phase below except 7–8.

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
| 3 | Dry-run language matching | No | All 14 languages correctly resolved via tags; validation checklist output matches manual review |
| 4 | Dry-run full execution | No | End-to-end dry-run output (§23 format) reviewed and approved by you before any write path is enabled |
| 5 | Test against a controlled/test campaign | Yes, but only a throwaway test campaign you create for this purpose | A real schedule/send round-trips correctly on a campaign nobody but you sees |
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
- Minimum scopes requested at each phase (see API_CAPABILITY_MATRIX.md) — `campaigns:write` isn't
  requested on the key until Phase 6.
- `.env` stays gitignored; `.env.example` ships with empty placeholders only.
