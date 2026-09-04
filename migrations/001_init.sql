-- See docs/ARCHITECTURE.md "Database schema" for the design rationale behind each column.

create extension if not exists pgcrypto;

create table campaign_group_executions (
  id                  uuid primary key default gen_random_uuid(),
  campaign_group_tag  text not null,
  en_campaign_id      text not null,
  status              text not null default 'PENDING',
  winner_variation    text,
  winner_message_id   text,
  click_rate_a        numeric, click_rate_b       numeric,
  placed_order_rate_a numeric, placed_order_rate_b numeric,
  decided_by          text, -- 'conversion_rate' | 'click_rate_tiebreak'
  poll_window_start   timestamptz,
  poll_window_end     timestamptz,
  snapshot_recipients_a integer, snapshot_recipients_b integer,
  snapshot_classification text,
  poll_attempts       integer not null default 0,
  failure_reason      text,
  automation_version  text not null,
  automation_enabled  boolean not null,
  dry_run             boolean not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (campaign_group_tag)
);

create table language_campaign_results (
  id                    uuid primary key default gen_random_uuid(),
  execution_id          uuid not null references campaign_group_executions(id),
  language_code         text not null,
  campaign_id           text,
  keep_message_id       text, -- the winning variation's message id -- what a human should keep
  delete_message_id     text, -- the losing variation's message id -- what a human should delete
  validation_status     text not null,
  validation_failures   jsonb,
  action                text not null, -- AWAITING_MANUAL_ACTION | CONFIRMED_SENT | MISMATCH_DETECTED
  confirmed_at          timestamptz,
  created_at            timestamptz not null default now(),
  unique (execution_id, language_code)
);

create table campaign_exclusions (
  campaign_group_tag text primary key,
  reason             text not null,
  created_at         timestamptz not null default now()
);

create table run_heartbeats (
  id         uuid primary key default gen_random_uuid(),
  ran_at     timestamptz not null default now(),
  families_seen integer not null default 0,
  dry_run    boolean not null,
  automation_enabled boolean not null
);
