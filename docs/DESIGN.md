# Klaviyo Campaign Sync — Design Document (Phase 0)

Status: **DRAFT FOR REVIEW — no code that touches the real Klaviyo account has been written yet.**
This document is deliverable #1–15 required before implementation. It is built from verified
current Klaviyo API documentation (see [API_CAPABILITY_MATRIX.md](./API_CAPABILITY_MATRIX.md) for
sources) plus decisions that need your sign-off, flagged inline as **DECISION NEEDED**.

---

## 1. What this system does

After the EN campaign's native Klaviyo A/B test has run its course, this service:

1. Computes our own winner (Click Rate primary, Placed Order Rate override at ≥10% relative
   difference) from Klaviyo's Reporting API — independently of whatever Klaviyo's own internal
   A/B logic does with the EN campaign's remaining 80%.
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
our own winner via Click Rate + Placed Order override, independent of Klaviyo's own algorithm") is
the *only* viable approach anyway — there's no Klaviyo-declared winner we could either use or need
to override.

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
- **Concrete illustration of why this matters**: applying the §4 algorithm to that real test's
  (already-contaminated) numbers — A: click 0.569%/conv 0.056%, B: click 0.502%/conv 0.108% —
  flips the decision to B on the conversion override, directly contradicting the fact that
  Klaviyo already delivered A to 90% of the list. Computing "our own independent winner" from
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

**Why this needs your sign-off**: it's a change to how you build campaigns in the Klaviyo UI (two
tags per campaign, ~15 clicks per send), not just a backend implementation detail. If you'd rather
not add tags, the fallback is name-based grouping by common subject-line stem with the `(xx)`
suffix stripped — I can build that, but per your own instructions I need to flag it explicitly as
higher-risk (subject lines can collide, get retyped slightly differently per language, etc.) and
you'd be accepting that risk knowingly rather than it being silently assumed.

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
    # 0. Completeness gate — see §7 for the full edge-case table
    if not dataComplete(A) or not dataComplete(B):
        return STOP("incomplete reporting data")

    # 1. Primary metric
    if A.click_rate == B.click_rate:
        clickWinner = TIE
    elif A.click_rate > B.click_rate:
        clickWinner = A
    else:
        clickWinner = B

    if clickWinner == TIE and A.placed_order_rate == B.placed_order_rate:
        return STOP("exact tie on both click rate and conversion rate — no safe default")

    # 2. Conversion override — ONLY applies when one side's Placed Order Rate is
    #    at least 10% relatively higher than the other's.
    #    relative_diff = |rate_high - rate_low| / rate_low   (guarding rate_low == 0, see §7)
    higherConv = A if A.placed_order_rate > B.placed_order_rate else B
    lowerConv  = B if higherConv == A else A
    if lowerConv.placed_order_rate == 0:
        convOverrideEligible = higherConv.placed_order_rate > 0   # any positive vs zero
        relDiff = INFINITY if convOverrideEligible else 0
    else:
        relDiff = (higherConv.placed_order_rate - lowerConv.placed_order_rate) / lowerConv.placed_order_rate

    convOverrideTriggers = relDiff >= 0.10   # the 10% threshold, defined once, here only

    if convOverrideTriggers:
        winner = higherConv
    elif clickWinner == TIE:
        return STOP("click rate tied and conversion difference below 10% — no deterministic winner")
    else:
        winner = clickWinner

    return winner
```

Worked examples from your spec both check out under this pseudocode:
- CR 5.00/4.80, POR 1.00/1.15 → relDiff = (1.15−1.00)/1.00 = 15% ≥ 10% → **B overrides** ✔
- CR 5.00/4.80, POR 1.00/1.05 → relDiff = 5% < 10% → **A wins on Click Rate** ✔

The 10% threshold is a **relative** difference (percentage-of-the-lower-value), matching your
worked examples exactly — this needed to be pinned down explicitly since "10% higher" is ambiguous
between relative and absolute-percentage-point without an example to check against.

---

## 5. Edge cases (§7 of your spec) — explicit handling

| Condition | Detection | Action |
|---|---|---|
| A or B has no metrics row at all | Reporting API returns fewer than 2 groups for the campaign | STOP |
| click_rate missing/null on either side | field absent or null in response | STOP |
| placed_order_rate missing/null | field absent or null | STOP — conversion override cannot be safely evaluated, fall back is **not** to silently skip the override, it's to halt, since Placed Order data being unavailable could mean it never populated, not that it's genuinely zero |
| zero recipients on either variation | `recipients` stat == 0 | STOP — rates computed from 0 recipients are undefined, not 0% |
| zero clicks, zero orders (but recipients > 0) | rates legitimately 0.00% | Valid data — proceeds through the algorithm normally (0% is a real value, not missing data) |
| equal click rates | see algorithm §4 | Falls through to conversion-override-or-STOP path |
| equal conversion rates | relDiff == 0 | Override never triggers; Click Rate decides (or STOP if that's also tied) |
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

**Resolved by live-account inspection (2026-09-03), pending one confirmation from your team.**
Inspected all 14 real language campaigns in the "Why the order of your skincare can matter"
family: every single one has exactly **one** campaign-message, always with
`send_strategy.method: "static"`. None had two. The strong working hypothesis — consistent
across all 14, not a one-off — is **(b)**: a `"static"`-strategy (non-A/B) campaign structurally
holds only one message per channel in Klaviyo, so there is no second variation to select between
or delete in the first place; whoever prepares these drafts sets/edits that single message's
content once the winner is known. Supporting evidence: the French campaign's message was created
at 07:11 UTC today — after the EN test's result was already knowable — with subject/preview text
that's an exact translation of EN Variation A's (the actual winner).

This is an empirical finding, not something read from documentation, so it needs one direct
confirmation from whoever on your team builds these drafts: **do language campaigns ever exist
with two messages, or do they always start as one and get edited once the winner's known?** If
confirmed, v1 implementation is simply: `PATCH /api/campaign-messages/{id}` with the winning
variation's `content` fields (subject, preview_text, body) copied over — never a delete call,
consistent with §7 above.

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
