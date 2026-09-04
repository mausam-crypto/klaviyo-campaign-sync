# klaviyo-campaign-sync

Automates what happens after Cellexia's EN Klaviyo campaign's native A/B test concludes:
computes an independent winner (Click Rate primary, Placed Order Rate override), then applies
that winner's content to the 14 language-campaign drafts and schedules them for 10 AM recipient
local time.

**Read [docs/DESIGN.md](docs/DESIGN.md) first.** It documents the business logic, the Klaviyo API
behavior this depends on (some of it verified against real account data, not just docs — see
docs/API_CAPABILITY_MATRIX.md and docs/VALIDATION.md), and — critically — a real platform
limitation (Klaviyo's own rollout contaminates reporting data before "test complete" is
detectable) and how this project works around it.

## Status

Phases 1–3 of the rollout plan (docs/ARCHITECTURE.md) are built and validated against live,
real Klaviyo data (read-only). Phase 4+ (Postgres-backed idempotency, the write path, Slack
notifications) is implemented but **not yet live-tested** — no Postgres or Slack webhook is
provisioned yet.

## Setup

```bash
npm install
cp .env.example .env   # fill in KLAVIYO_API_KEY at minimum
```

## Commands

- `npm run discover` — read-only dump of recent campaigns (Phase 1).
- `npm run phase2` — winner-algorithm validation against real historical data, no live calls.
- `npm run phase3` — live, read-only family-matching + validation dry run.
- `npm run run` — the full pipeline (`src/run.mjs`), gated by `AUTOMATION_ENABLED` and `DRY_RUN`.
  This is what the Render Cron Job invokes every 5 minutes in production.

## Safety defaults

`AUTOMATION_ENABLED=false` and `DRY_RUN=true` in `.env.example` and `render.yaml`. Flipping either
to a live value is a manual decision made once a phase's success criteria (docs/ARCHITECTURE.md)
are met — never a side effect of a deploy.
