# Phase 1–3 validation results (2026-09-03)

Run with `npm run phase2` and `npm run phase3`. Both are read-only / no-Klaviyo-writes.

## Phase 2 — winner algorithm

Winner rule (final, 2026-09-03): Placed Order Rate (conversion) is the sole primary metric —
higher conversion wins outright. Click Rate only breaks an exact tie on conversion rate. See
DESIGN.md §4.

- All 5 sanity checks pass: conversion decides even against a less-favorable click rate (both
  directions), a conversion-rate tie correctly falls through to the click-rate tiebreak, an
  exact tie on both stops with no default, and missing/zero recipients stops.
- Run against the two real, fully-settled historical EN tests found during discovery, both
  correctly classify as `CONTAMINATED` (recipient ratio ~9:1) — meaning in production,
  `decideWinner()` would never be called on this data; the automation would STOP and alert
  instead. The illustrative decision for each (B, then A, both via `conversion_rate`) is printed
  for illustration only and disagrees with what Klaviyo actually sent in both cases — the exact
  failure mode the classification gate exists to catch. See DESIGN.md §2.

## Phase 3 — family/language matching, live data

Ran against the 50 most recent real email campaigns. Findings:

- **"Why can your skin feel different after washing somewhere new?"** — future send, EN only
  exists as a Draft A/B test, no language campaigns created yet. Correctly detected as
  incomplete (14/14 languages missing) → correctly stops the whole family, touches nothing.
- **"Why the order of your skincare can matter"** and **"Why does your skin feel different after
  a workout?"** — both fully sent already. Family/language matching correctly resolves all 14
  languages by name for both. Per-language validation correctly fails every campaign on
  `status_is_draft` / `not_already_scheduled_or_sent` (they're already `Sent`), and on
  `has_both_variations` (each now has only the surviving message, the loser already deleted
  manually for that send) — proving the validator won't attempt to act on an already-processed
  campaign.
- **Real, previously-unknown finding**: the local-timezone-send validation check
  (`local_timezone_send_enabled`) failed for `es` in the skincare family and for `fr`, `pt`, `ro`,
  `sv` in the workout family — 5 real instances across just 2 families where the current manual
  process did not enable recipient-local-time send, contrary to the stated 10 AM local time
  policy. All already sent, so nothing actionable retroactively, but this is concrete evidence
  the automation's validation step catches a real, recurring gap in the current manual workflow.

## Known limitation carried forward

Family/language matching uses the name-based fallback (`src/family.mjs`) for every real family
seen so far, because no campaign in this account currently has any tags set. Risks are documented
inline in that file. The stakes of a mismatch here are lower than they'd otherwise be, since the
automation only ever produces a Slack notification, never a Klaviyo write (see below) — but still
worth adopting `group:`/`lang:` tags for reliability.

## 2026-09-03: winner rule + write-path decisions, both revised same day

Two design points changed after direct discussion, in this order:

1. Winner rule switched from click-rate-primary/10%-conversion-override to conversion-rate-only
   (above).
2. Variation removal was briefly redesigned to a two-campaign-per-language structure
   (`variant:a`/`variant:b` tags, automation schedules the winner and archives the loser) to work
   around the missing delete-message API — then explicitly reverted the same day: you want to
   stay at 14 language campaigns, both variations in one. Combined with confirming
   `POST /api/campaign-send-jobs` has no message-selection field and there's no "primary message"
   concept either, there is no way for the automation to finish this step itself while keeping
   that structure. **Final decision: the automation stops at winner detection.** It validates all
   14 language campaigns, identifies exactly which message to keep and which to delete per
   language (label-based, `identifyVariationMessages()`), and hands off to a human via Slack
   (`notifyWinnerReady()`). A later run verifies the human's action landed correctly
   (`verifyManualCompletion()`) before marking the family `SUCCESS`, and raises a one-time
   `notifyMismatch()` alert if the wrong message ended up being the one left standing.

This is implemented in `src/run.mjs` but **not yet run against real data** — no Postgres is
provisioned yet, and no real family has reached the point in its lifecycle where this path would
fire.
