# Phase 1–3 validation results (2026-09-03)

Run with `npm run phase2` and `npm run phase3`. Both are read-only / no-Klaviyo-writes.

## Phase 2 — winner algorithm

- `decideWinner()` matches both worked examples from your original spec exactly (relative
  conversion-rate difference, 10% threshold, click-rate fallback).
- All 4 sanity checks pass (override case, click-rate-wins case, exact-tie STOP, zero-recipients
  STOP).
- Run against the two real, fully-settled historical EN tests found during discovery, both
  correctly classify as `CONTAMINATED` (recipient ratio ~9:1) — meaning in production,
  `decideWinner()` would never be called on this data; the automation would STOP and alert
  instead. The decision each would have produced is printed for illustration only, and in both
  cases it disagrees with what Klaviyo actually sent — which is the exact failure mode the
  classification gate exists to catch. See DESIGN.md §2.

## Phase 3 — family/language matching, live data

Ran against the 50 most recent real email campaigns. Findings:

- **"Why can your skin feel different after washing somewhere new?"** — future send, EN only
  exists as a Draft A/B test, no language campaigns created yet. Correctly detected as
  incomplete (14/14 languages missing) → correctly stops the whole family, touches nothing.
- **"Why the order of your skincare can matter"** and **"Why does your skin feel different after
  a workout?"** — both fully sent already. Family/language matching correctly resolves all 14
  languages by name for both. Per-language validation correctly fails every campaign on
  `status_is_draft` / `not_already_scheduled_or_sent` (they're already `Sent`) — proving the
  validator won't attempt to touch an already-processed campaign, which is the core duplicate-send
  protection this checklist exists for.
- **Real, previously-unknown finding**: the local-timezone-send validation check
  (`local_timezone_send_enabled`) failed for `es` in the skincare family and for `fr`, `pt`, `ro`,
  `sv` in the workout family — 5 real instances across just 2 families where the current manual
  process did not enable recipient-local-time send, contrary to the stated 10 AM local time
  policy. All already sent, so nothing actionable retroactively, but this is concrete evidence
  the automation's validation step catches a real, recurring gap in the current manual workflow.

## Known limitation carried forward

Family/language matching here uses the name-based fallback (`src/family.mjs`), not the
tag-based approach recommended in DESIGN.md §3, because no campaign in this account currently has
any tags set. Risks are documented inline in that file. Revisit once/if tags are adopted.

## 2026-09-03 update: winner rule change + dual-campaign structure

Per your direction, the winner rule is now conversion-rate-primary (Placed Order Rate decides
outright; Click Rate only breaks an exact tie) — `scripts/phase2` re-run and re-verified above
reflects this. Both historical fixtures still correctly classify `CONTAMINATED` and are never
actually decided on in production; the illustrative `decideWinner()` output for them changed
(now B and A respectively, both via `conversion_rate`) but the safety gate's behavior didn't.

Also per your direction: language campaigns are being restructured from one campaign with two
messages (today's real shape, confirmed by you) to two separate single-message campaigns per
language (`variant:a` / `variant:b` tags), since no supported Klaviyo API can remove one message
from the former. `src/validate.mjs::validateDualCampaignLanguage()` and the corresponding
`family.mjs` grouping logic are implemented but **not yet run against real data** — no campaign in
the account uses this structure or these tags yet. `npm run phase3` still only exercises the
legacy path, since that's all that exists live right now.
