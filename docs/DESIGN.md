# Klaviyo Campaign Sync — Design Document (Phase 0)

Status: **DRAFT FOR REVIEW — no code that touches the real Klaviyo account has been written yet.**
This document is deliverable #1–15 required before implementation. It is built from verified
current Klaviyo API documentation (see [API_CAPABILITY_MATRIX.md](./API_CAPABILITY_MATRIX.md) for
sources) plus decisions that need your sign-off, flagged inline as **DECISION NEEDED**.

---

## 1. What this system does

After the EN campaign's native Klaviyo A/B test has run its course, this service:

1. Computes our own winner (Placed Order Rate is the sole primary metric — whichever variation
   converts more wins; Click Rate only breaks an exact tie, revised 2026-09-03, see §4) from
   Klaviyo's Reporting API — independently of whatever Klaviyo's own internal A/B logic does with
   the EN campaign's remaining 80%.
2. Finds the 14 language-campaign drafts belonging to the same campaign family.
3. Validates every one of them.
4. Schedules the winning variation in each, at 10:00 AM recipient local time.
5. Never sends twice, never sends on ambiguous data, and logs/alerts every step.

It does **not** touch the EN campaign's own A/B rollout — Klaviyo continues to own that natively.

---

## 2. Critical fact this design depends on (verified, not assumed)

**Klaviyo's stable API does not expose "A/B test complete" or "declared winner" as a field,
anywhere** — not on the campaign object, not on campaign-messages, not on the reporting API. This
was confirmed by reading the actual stable `campaigns.json` OpenAPI spec (revision `2026-07-15`),
not inferred. See capability matrix Q2/Q3.

This is actually *convenient* for us, not a blocker: it means the business requirement ("compute
our own winner from Placed Order Rate, independent of Klaviyo's own algorithm") is the *only*
viable approach anyway — there's no Klaviyo-declared winner we could either use or need to
override.

**Revised after live-account verification (2026-09-03) — this is more subtle than originally
designed, and the fix below replaces an earlier draft of this section that assumed waiting for
`status == "Sent"` was safe. It is not.** Verified against a real, already-completed EN test
("Why the order of your skincare can matter", sent 2026-09-02T09:30Z, configured 24h test
duration):

- Per-variation stats pulled from `campaign-values-reports` for the **losing** variation stayed
  clean forever (its `recipients` count, 5,587, is almost exactly the original 10% test-only
  cohort — the 355-day and the exact-24h timeframe queries returned identical numbers).
- The **winning** variation's stats are contaminated the moment Klaviyo's own rollout fires:
  its `recipients` count (50,313 ≈ 90% of the list) already includes the 80% rollout audience
  merged into the same figures the original 10% test cohort produced, and there is no way to
  retroactively separate them — the Reporting API has no sub-day timeframe granularity fine
  enough to isolate "before rollout" from "after," and both an unbounded and an exact
  `[send_time, send_time+24h]` window returned the identical, already-merged numbers.
- **The rollout does not necessarily wait for the full configured test duration.** For this real
  test, the EN campaign's own `updated_at` (05:31, ~20h post-send) predates the nominal 24h
  boundary (09:30) by about 4 hours, and a language-campaign message already carrying the
  winning variation's content existed by 07:11 — well before the 24h mark. A fixed
  `send_time + TEST_DURATION_HOURS` offset is **not a reliable trigger**; treat
  `TEST_DURATION_HOURS` as an upper bound on when polling needs to be watching closely, not the
  moment itself.
- **Concrete illustration of why this matters**: applying the §4 algorithm (conversion rate
  primary) to that real test's (already-contaminated) numbers — A: conv 0.056%, B: conv 0.108% —
  picks B, directly contradicting the fact that Klaviyo already delivered A to 90% of the list.
  Computing "our own independent winner" from
  post-rollout data isn't independent at all — it's biased toward whichever variation has the
  larger, blended sample.

**Corrected detection strategy** (approved direction: aggressive polling + a balance safety
check, not a heavier custom Events-API aggregation):

1. Once a family's EN campaign is known (`send_strategy.method == "ab_test_campaign"`,
   `send_time` populated), start polling `campaign-values-reports` (grouped by
   `campaign_id, campaign_message_id, variation`) starting well before the configured
   `TEST_DURATION_HOURS` and continuing for a margin after it — e.g. from
   `send_time + TEST_DURATION_HOURS × 0.5` through `send_time + TEST_DURATION_HOURS × 1.5`,
   at a 2–5 minute cadence within that window (coarser, e.g. every 15–30 min, before it, to
   conserve the endpoint's tight 2/min·225/day budget).
2. **On every poll, classify the reading before trusting it**, using each variation's
   `recipients` against the configured test-size split (10%/10%, config value, ±tolerance):
   - Both variations' recipients still near/below their expected test-size share → **too early**,
     keep polling, not an error.
   - Both variations' recipients close to their expected, roughly equal share, and both above a
     minimum sample floor → **clean snapshot** — compute the winner now via §4 and stop polling
     this family; do not wait for a later, "more complete" reading, since every subsequent
     reading is progressively more likely to already be contaminated.
   - One variation's recipients far exceeds its expected share while the other stays flat
     (contamination signature) → **we missed the clean window**. Do not compute a winner from
     this reading. STOP and alert: "could not obtain an uncontaminated snapshot for winner
     computation" — this is a real, expected failure mode to design for, not a bug to silently
     paper over.
3. If polling exhausts the whole window (`× 1.5` of `TEST_DURATION_HOURS`) without ever
   classifying a clean snapshot, STOP and alert the same way.

This still carries residual race-condition risk against an internal Klaviyo process we cannot
observe directly — tightening the poll interval narrows it but can't eliminate it. That tradeoff
was discussed with you directly and this is the approved approach over building custom
Events-API-based aggregation (heavier, but immune to this contamination entirely) for v1.

---

## 3. Campaign-family & language identification — DECISION NEEDED

Current process names campaigns `"<subject> (en)"`, `"<subject> (de)"`, etc. The spec explicitly
forbids relying on that as the *primary* mechanism, and after checking, Klaviyo campaigns do carry
a native, filterable relationship that fits better: **Tags** (`GET /api/campaigns` supports
`tags` as an included relationship, and there is a Tags API to create/list/filter by tag).

**Proposed convention** (a small addition to your existing manual campaign-creation step, not a
replacement of it):

- When you create the 15 campaigns (EN + 14 languages) for one send, apply **two tags** to each:
  - `group:<slug>` — identical across all 15 campaigns in that family, e.g. `group:2026-09-03-skincare-order`
    (date + short slug keeps it unique and human-legible; the automation doesn't parse it, it just
    matches on exact string).
  - `lang:<code>` — the campaign's own language, e.g. `lang:en`, `lang:fr`, `lang:de`.

The automation then builds its family map by querying campaigns filtered by the `group:` tag and
reading each one's `lang:` tag — a deterministic, auditable lookup with no fuzzy string matching.
The `"(xx)"` name suffix becomes a **secondary cross-check only**: if a campaign's name-derived
language disagrees with its `lang:` tag, that's a validation failure (STOP), not something the
automation silently resolves.

**Superseded (2026-09-03 → 2026-09-05).** The tag approach was implemented briefly, then dropped
in favor of a name-based convention when §7's final decision (28-campaign split) settled on your
own naming scheme instead: `"<subject> (xx) (a)"` / `"<subject> (xx) (b)"` per language, `"<subject>
(en)"` unchanged for EN. `src/family.mjs` now identifies structure purely from these two suffix
shapes — no tags involved. This also means the stakes discussion below is reversed from an
earlier draft of this section: since §7's final decision has the automation actually schedule and
archive real campaigns for `dual_campaign` families (not just notify), getting family/language
identification right matters at full stakes again, not reduced ones. The documented risks of
name-based matching (translation drift, inconsistent suffix casing, etc.) still apply — worth
keeping in mind if this ever causes a real mismatch, at which point Klaviyo tags remain available
as a more robust upgrade.

The legacy single-suffix pattern (`"(xx)"` alone, no `(a/b)`) still identifies old-style families
for read-only reporting — see §7.

---

## 4. Winner decision algorithm (deterministic, no invented thresholds)

Inputs, pulled via `POST /api/campaign-values-reports` grouped by `campaign_message_id` for the EN
campaign (see capability matrix Q4 for confirmed request/response shape):

```
click_rate_A, click_rate_B            -- statistic "click_rate"
placed_order_rate_A, placed_order_rate_B  -- statistic "conversion_rate" with
                                             conversion_metric_id = this account's real
                                             "Placed Order" metric id (looked up via
                                             GET /api/metrics, never hardcoded)
recipients_A, recipients_B            -- for the completeness/edge-case checks below
```

```
function decideWinner(A, B):
    # 0. Completeness gate — see §5 for the full edge-case table
    if not dataComplete(A) or not dataComplete(B):
        return STOP("incomplete reporting data")

    # 1. Primary (and now only) metric: Placed Order Rate. Whichever variation converts
    #    more wins — no threshold, no override concept. This replaced an earlier
    #    click-rate-primary / conversion-override design (see git history for the prior
    #    version) at your explicit direction on 2026-09-03.
    if A.placed_order_rate != B.placed_order_rate:
        return A if A.placed_order_rate > B.placed_order_rate else B

    # 2. Exact tie on conversion rate — Click Rate breaks the tie.
    if A.click_rate != B.click_rate:
        return A if A.click_rate > B.click_rate else B

    # 3. Tied on both — no safe default.
    return STOP("exact tie on both conversion rate and click rate — no safe default")
```

This is a deliberately simple rule: implemented in `src/winner.mjs::decideWinner()`, validated
in `scripts/phase2-validate.mjs`. There is no configurable threshold to tune — see §4 (old) in
git history if you ever want the prior click-rate-primary / 10%-override version back.

---

## 5. Edge cases (§7 of your spec) — explicit handling

| Condition | Detection | Action |
|---|---|---|
| A or B has no metrics row at all | Reporting API returns fewer than 2 groups for the campaign | STOP |
| placed_order_rate missing/null on either side | field absent or null in response | STOP — this is now the primary metric, so missing data here is disqualifying, not just for an override |
| click_rate missing/null | field absent or null | STOP — still required as the tiebreaker; can't safely skip it in case it's needed |
| zero recipients on either variation | `recipients` stat == 0 | STOP — rates computed from 0 recipients are undefined, not 0% |
| zero clicks, zero orders (but recipients > 0) | rates legitimately 0.00% | Valid data — proceeds through the algorithm normally (0% is a real value, not missing data) |
| equal conversion rates | see algorithm §4 | Falls through to the click-rate tiebreak |
| equal click rates too (after a conversion-rate tie) | both metrics tied | STOP — no safe default |
| API response incomplete / malformed | schema validation failure on the parsed response | STOP, log raw response body (redacting nothing sensitive is in it, but still logged to our own store, never to Slack) |
| test not yet complete | gate in §2 not satisfied | Do not STOP — this is the normal "not yet time" state; automation simply does nothing this run and checks again next scheduled run |
| campaign status unexpected | status not in the known-safe enum for its phase | STOP |

**"STOP" always means**: no language campaign is touched, an audit log entry is written with
`status: FAILED` and the specific reason, and a Slack alert fires. Never a partial/best-guess send.

---

## 6. Language-campaign validation (§10) — checklist, all-or-nothing per family

Before scheduling *any* of the 14, all 14 must independently pass:

1. Family tag (`group:<slug>`) matches.
2. `lang:<code>` tag present and matches expected code; cross-checked against `(xx)` name suffix.
3. Campaign resolved to exactly one campaign ID for this family+language (zero or >1 matches = STOP).
4. `status == "Draft"`.
5. Exactly two campaign-messages exist on the campaign.
6. The winning variation (matched by a **stable identifier**, not array order — see §8) exists
   among those two messages.
7. Campaign is not `Scheduled`/`Sending`/`Sent`/any `Cancelled:*` state.
8. `audiences.included` is non-empty and matches the expected segment/list ID convention (config,
   confirmed against real campaigns in Phase 1 discovery before this check is finalized).
9. `send_options`/`tracking_options` present and sane (non-empty from-email etc.).
10. Local-timezone send is configured correctly (see §9).
11. Computed local send time resolves to 10:00 AM.
12. No prior execution record for this family+language pair (idempotency store, §12).
13. (same as 12 — duplicate-send protection is one mechanism, listed twice in your spec)
14. Campaign's current draft content hash matches a hash captured at discovery time, if we
    captured one earlier in the run — guards against someone hand-editing the draft mid-run.

**Default failure policy = STOP THE ENTIRE FAMILY**, per your explicit instruction in §10. A
configurable per-language skip policy is *not* implemented in v1 — adding it later is possible but
starts as off, matching "fail closed" as the only mode until you decide otherwise.

---

## 7. Variation selection & the losing variation — no deletion in v1

**Verified**: there is no documented `DELETE` endpoint for a single campaign-message (searched
the reference docs directly — a guessed URL 404'd, and no such endpoint appears in the reference
index). This resolves §11 of your spec ("delete ONLY if officially supported and safe") in the
safe direction: **it is not supported, so we don't attempt it.**

**v1 approach**: leave both variations' campaign-messages exactly as they are. A Klaviyo campaign
schedules and sends **the whole campaign**, not a hand-picked single message — so for a plain
(non-A/B) campaign to send only the winning content, the campaign itself must be structured so its
"live" content is the winner. Two real options, to be confirmed in Phase 1 live discovery against
how your language-campaign drafts are actually built today:

- **(a)** If the language campaign's *primary* message already holds one variation's content and
  the second "B" message is a separate, non-primary campaign-message purely for
  side-by-side content prep — then "selecting" the winner may just mean confirming the primary
  message already matches, and scheduling as-is (no write to campaign content at all).
- **(b)** If the language campaign is itself set up as a two-message structure Klaviyo would
  otherwise treat as its own A/B test — then "selecting" the winner means **updating the primary
  send message's `content`/`definition` to the winning variation's content** via
  `PATCH /api/campaign-messages/{id}` (confirmed to exist, `campaigns:write` scope), rather than
  deleting anything.

**Corrected by you directly (2026-09-03) — the single-message read from Phase 1 discovery was a
false signal, not the real shape.** You confirmed: language drafts really do carry both Variation
A and Variation B, and your team manually deletes the losing one once the EN winner is known. The
"every campaign I looked at had exactly one message" finding was simply catching each one *after*
that manual deletion had already happened for that day's send — not evidence the drafts start
with one.

**This creates a real, verified blocker**, checked directly against the raw stable OpenAPI spec
(`2026-09-03`), not inferred:

- `DELETE /api/campaign-messages/{id}` — **does not exist.** Only `GET` and `PATCH` are defined
  for that path in the spec.
- `PATCH`/`DELETE` on the campaign → campaign-messages relationship (the JSON:API pattern that
  would let you unlink one message without deleting the resource) — **does not exist.** Only
  `GET /api/campaigns/{id}/relationships/campaign-messages` is defined; read-only.
- `POST /api/campaign-clone` — **exists**, but always clones the entire campaign including every
  message, with no field to select a subset. Cloning doesn't produce a single-message campaign
  either.

**There is no documented, stable Klaviyo API operation that removes one variation from a
two-message campaign.** Whatever your team's manual delete action in the Klaviyo UI actually
calls, it isn't part of the public API surface this project is restricted to (per your own rule
against undocumented endpoints) — so the automation cannot literally replicate that click today.

**This whole question went through three rounds before landing.**

1. (2026-09-03) Considered restructuring into two single-message campaigns per language, letting
   the automation schedule/archive within the supported API — rejected the same day, wanting to
   stay at 14 language campaigns.
2. (2026-09-03) With 14 campaigns confirmed as the constraint, and `POST /api/campaign-send-jobs`
   confirmed to have no message-selection field and no "primary message" concept either, decided
   the automation stops at winner detection and hands off to a human (`notifyWinnerReady()` +
   `verifyManualCompletion()`) — implemented, tested against real data, deployed to production.
3. **(2026-09-05, final) Reopened and reversed**: you asked whether the automation could send the
   winner itself. Re-examining the tradeoff: the 28-campaign split isn't just "the only API-clean
   option" — it also completely removes the *technical* risk that made option 1 unappealing,
   because every campaign under that structure has exactly one message. There's no "does sending
   a two-message campaign deliver both variants" question to even worry about; scheduling and
   sending a single-message campaign is Klaviyo's ordinary, fully-documented behavior. **Decided:
   go with the 28-campaign split after all**, named `"<subject> (xx) (a)"` / `"<subject> (xx)
   (b)"` per language (your exact convention) — the automation now finishes the job itself:
   schedules the winning campaign, archives the losing one (`archived: true` — reversible, not a
   delete), no human step required.

**Naming/identification, final**: name-based (matching your chosen convention), not tags — see
`src/family.mjs`. A family is `dual_campaign` structure if its language entries end in `(xx) (a)`/
`(xx) (b)`; `legacy_single_campaign` if they end in a plain `(xx)` (every already-sent real
campaign looks like this, kept for read-only reporting only, since it's structurally incapable of
ever reaching the write path). The two never mix within one family without being flagged as a
conflict.

**Naming convention amended (2026-09-11): switched from parens to brackets.** Klaviyo-side issue
with `"(...)"` in new campaign names (not a preference) means every campaign built from this date
forward uses `"<subject> [xx]"` / `"<subject> [xx][a]"` / `"[xx][b]"` instead of the parenthesized
forms above. `src/family.mjs`'s `LANGUAGE_SUFFIX`/`VARIANT_SUFFIX` regexes now accept both styles,
so already-sent real campaigns (all paren-style) keep resolving for read-only reporting — but no
new campaign should be built with parens going forward. A single suffix mixing styles (e.g.
`"(fr)[a]"`) is deliberately not recognized as either shape, matching nothing rather than
guessing.

**Consequence for the API key**: this write path needs `campaigns:write` — `PATCH
/api/campaigns/{id}` (set schedule) and `{id}`/`archived` (archive the loser), plus
`POST /api/campaign-send-jobs` (send). The key created for Phase 1 discovery was deliberately
read-only (`campaigns:read`, `metrics:read`, `tags:read`) and Klaviyo doesn't allow adding scopes
to an existing key — a new key (or a scope-expanded replacement) is needed before this can run for
real. §11's earlier note that `campaigns:write` would "never" be needed no longer holds after this
reversal.

The legacy handoff flow (`notifyWinnerReady()`/`verifyManualCompletion()`) stays in the codebase
for any family still using the old structure — it just won't be exercised for new sends once your
team builds language campaigns the new way.

---

## 8. Variation identity — durable key, not array order or label text

Confirmed: a campaign-message's `label` field is free text set at creation, not a semantic A/B
enum, and array order is not documented as stable. **The durable identifier is the
campaign-message's own `id`.** The automation resolves "which message is Variation A" once, at
discovery time for the EN campaign (by `label` matching `"Variation A"`/`"A"`-style text, cross-
checked against send order/whatever signal Phase 1 discovery finds most reliable), records that
`campaign_message_id → A|B` mapping in the audit log, and from then on only ever compares IDs —
never re-derives "A vs B" from label text mid-run.

---

## 9. 10:00 AM recipient local time (§12)

Confirmed via the live `Update Campaign` schema (stable, `2026-07-15`):

```
send_strategy: {
  method: "static",
  options: {
    datetime: "<any placeholder time, e.g. 10:00 in campaign's own reference frame>",
    is_local: true
  }
}
```

`is_local: true` is what makes Klaviyo interpret the given clock time as "this local time in each
recipient's own timezone" rather than one fixed UTC instant — this is the confirmed programmatic
equivalent of the UI's "recipient local timezone" checkbox. No separate `LOCAL_TIMEZONE` enum
value exists on stable; an earlier search result suggesting that was wrong and is discarded (see
capability matrix Q7 for the correction trail — this is a good example of why nothing in this
project ships from a single unverified web-search summary).

---

## 10. API capability matrix, required scopes, rate limits, DB schema, idempotency, dry-run,
testing/deployment/monitoring/security plans

Split into companion documents to keep this one readable:

- [API_CAPABILITY_MATRIX.md](./API_CAPABILITY_MATRIX.md) — every endpoint, verified stable/beta
  status, scope, rate limit, and source.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — components, DB schema, idempotency mechanism, retry/rate-
  limit handling, dry-run mode, kill switches, phased testing plan (Phases 1–8), deployment plan,
  monitoring/alerting, security.

---

## 11. Open decisions before Phase 1 (live discovery) can start

**All resolved as of 2026-09-03** (kept below as a record of what was asked). **Superseded
2026-09-05**: §7 originally settled on a design where the automation never writes to Klaviyo,
making the `campaigns:write` scope in point 1 permanently unnecessary — that held for two days,
then §7 was reopened and reversed. The final design (28-campaign split) *does* write to Klaviyo
(schedule the winner, archive the loser), so `campaigns:write` is needed after all. Klaviyo
doesn't allow adding scopes to an existing key, so the original read-only key from Phase 1
discovery needs to be replaced with one that includes `campaigns:write` before this can run for
real.


1. **Klaviyo private API key** — create one scoped to (initially, read-only):
   `campaigns:read`, `metrics:read`, `tags:read`. Do not grant `campaigns:write` yet — that's only
   needed starting Phase 6. Paste the key value directly in chat; it will be used only via an
   environment variable, never written to a file, log, commit, or shown back to you in full.
2. **Slack webhook** — an Incoming Webhook URL (or bot token + channel) for the
   notifications in §18 of your spec.
3. **Tagging convention (§3 above)** — approve the `group:<slug>` + `lang:<code>` tag approach, or
   tell me to design the name-based fallback instead with its risks accepted.
4. **Variation-selection mechanism (§7 above)** — will be resolved once I can inspect one real
   language-campaign draft during Phase 1 discovery; no action from you needed yet beyond
   supplying the API key.
