# klaviyo-campaign-sync

Automates what happens after Cellexia's EN Klaviyo campaign's native A/B test concludes: computes
an independent winner (Placed Order Rate is the primary metric, Click Rate only breaks an exact
tie), validates the 28 language campaigns (two single-message campaigns per language, `"<subject>
(xx) (a)"` / `"(b)"`), then schedules the winner and archives the loser itself. An earlier design
(14 campaigns, both variations in one) had no supported way to finish that step automatically and
stopped at a Slack handoff instead — kept in the codebase for read-only reporting on old-style
campaigns, see docs/DESIGN.md §7 for the full history.

**Read [docs/DESIGN.md](docs/DESIGN.md) first.** It documents the business logic, the Klaviyo API
behavior this depends on (some of it verified against real account data, not just docs — see
docs/API_CAPABILITY_MATRIX.md and docs/VALIDATION.md), and — critically — a real platform
limitation (Klaviyo's own rollout contaminates reporting data before "test complete" is
detectable) and how this project works around it.

## Status

Phases 1–3 (docs/ARCHITECTURE.md) are built and validated against live, real Klaviyo data
(read-only). Phase 4 (Postgres-backed idempotency) is deployed on Render and confirmed working
against production — DB connectivity, Klaviyo connectivity, and the completion-verification logic
have all been tested against real data. **The write path for the current (dual-campaign) design
has not been run for real yet** — no campaign in the account uses the `(xx) (a)`/`(xx) (b)`
naming convention as of this writing, and the current Klaviyo API key is read-only (needs
`campaigns:write` added via a replacement key before this can schedule/archive anything for real).

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
  This is what the Render Cron Job invokes every 5 minutes in production — reads env vars
  directly from the process (Render injects them), no `.env` file involved.
- `npm run run:local` — same thing, but loads `.env` first, for running it on your own machine.
- `npm run migrate` — applies `migrations/*.sql` against `DATABASE_URL` (from `.env` locally, or
  export it inline for a one-off run against a remote database). Safe to re-run; only run once
  per fresh database in practice.

## Safety defaults

`AUTOMATION_ENABLED=false` and `DRY_RUN=true` in `.env.example` and `render.yaml`. Flipping either
to a live value is a manual decision made once a phase's success criteria (docs/ARCHITECTURE.md)
are met — never a side effect of a deploy.
