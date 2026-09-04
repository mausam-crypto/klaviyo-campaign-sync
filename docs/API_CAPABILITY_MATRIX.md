# API Capability Matrix

All facts below are sourced from a direct research pass against developers.klaviyo.com reference
pages and the stable OpenAPI spec (`openapi/stable/categories/campaigns.json`), not inferred.
Anything not directly confirmed is listed at the bottom under **Unverified — requires live-account
test**, per the "do not assume" requirement. Pin `revision: 2026-07-15` (current stable/GA) on
every request via the `revision` HTTP header — **never** the `2026-04-15.pre` / `2026-07-15.pre`
omnichannel-campaigns beta (GA not expected before 2026-10-15).

| # | Operation | Endpoint | Stable revision | Beta? | Required scope | Rate limit (Burst/Steady) | Verified how |
|---|---|---|---|---|---|---|---|
| 1 | Retrieve campaigns | `GET /api/campaigns` | 2026-07-15 | No | `campaigns:read` | 10/s, 150/m | Reference page |
| 2 | Retrieve one campaign | `GET /api/campaigns/{id}` | 2026-07-15 | No | `campaigns:read` | 10/s, 150/m | Reference page + raw spec |
| 3 | Retrieve campaign messages | `GET /api/campaign-messages` (filterable by `campaign.id`) or `GET /api/campaigns/{id}/campaign-messages` | 2026-07-15 | No | `campaigns:read` | 10/s, 150/m | Reference page |
| 4 | Retrieve campaign status | field on #2's response (`attributes.status`) | 2026-07-15 | No | `campaigns:read` | (same as #2) | Raw spec enum |
| 5 | Retrieve A/B variation performance | `POST /api/campaign-values-reports`, `group_by: ["campaign_message_id"]` | 2024-10-15 (Reporting API's own stable revision) | No | `campaigns:read` | **1/s, 2/m, 225/day** (tighter, endpoint-specific) | Reference page |
| 6 | Retrieve Click Rate | `statistics: ["click_rate"]` on #5 | 2024-10-15 | No | `campaigns:read` | (same as #5) | Reference page enum |
| 7 | Retrieve Placed Order Rate | `statistics: ["conversion_rate"]` on #5 with `conversion_metric_id` = this account's Placed Order metric id | 2024-10-15 | No | `campaigns:read` | (same as #5) | Reference page enum |
| 8 | Identify variation A/B | campaign-message `id` (durable) + `attributes.definition.label` (display only, not durable) | 2026-07-15 | No | `campaigns:read` | (same as #3) | Raw spec field description |
| 9 | Update campaign / campaign-message (schedule, or swap winning content) | `PATCH /api/campaigns/{id}` and/or `PATCH /api/campaign-messages/{id}` | 2026-07-15 | No | `campaigns:write` | 10/s, 150/m | Reference pages |
| 10 | Delete variation | **No documented endpoint found** (`delete_campaign_message` 404s; not in reference index) | — | — | — | — | Negative search result — see §7 of DESIGN.md; treated as unsupported |
| 11 | Schedule campaign | `PATCH /api/campaigns/{id}`, `send_strategy.method="static"`, `options.is_local=true` | 2026-07-15 | No | `campaigns:write` | 10/s, 150/m | Raw spec |
| 12 | Send campaign | `POST /api/campaign-send-jobs` | 2026-07-15 | No | `campaigns:write` (assumed by convention — **not explicitly quoted**, flagged below) | 10/s, 150/m | Reference page |
| 13 | Configure local-time scheduling | see #11 | 2026-07-15 | No | `campaigns:write` | — | Raw spec |
| 14 | Retrieve campaign tags/metadata | `GET /api/campaigns` with `tags` relationship included; Tags API for tag CRUD | 2026-07-15 | No | `campaigns:read`, `tags:read` | 10/s, 150/m (assumed standard M-tier, not individually re-verified) | Reference page relationship list |
| 15 | Look up "Placed Order" metric ID | `GET /api/metrics` (list, then filter client-side on `attributes.name == "Placed Order"`) | current | No | `metrics:read` | 10/s, 150/m | Reference page |
| — | Native A/B test config (split %, duration, winning metric) via API | **Not found in stable or beta specs searched** | — | — | — | — | Not needed for our design — see DESIGN.md §2 |
| — | Klaviyo-declared A/B winner / test-complete flag | **Confirmed absent from stable API** | — | — | — | — | Direct spec read (campaign status enum + reporting response shape both lack it) |

## Full campaign `status` enum (stable, confirmed from raw spec)

`Scheduled, Sent, Draft, Cancelled, Adding Recipients, Sending, Variations Sent, Sending Segments,
Cancelled: Smart Sending, Preparing to send, Cancelled: Account Disabled, Cancelled: No Recipients,
Preparing to schedule, Cancelled: Internal Error, Queued without Recipients, Cancelled: Billing
Limit, Cancelled: Misconfigured, Unknown`

Used for: draft-state validation (§10 of DESIGN.md expects exactly `"Draft"`), and the EN
test-complete gate (expects the campaign to have progressed to `"Sent"`; anything still cycling
through `"Sending"`/`"Variations Sent"`/`"Sending Segments"` past the expected window is a
stuck-state alert, not a silent wait).

## `campaign-values-reports` request shape (confirmed)

```json
{
  "data": {
    "type": "campaign-values-report",
    "attributes": {
      "statistics": ["click_rate", "conversion_rate"],
      "timeframe": { "key": "last_30_days" },
      "conversion_metric_id": "<Placed Order metric id, looked up per-account>",
      "filter": "equals(campaign_id,\"<EN campaign id>\")",
      "group_by": ["campaign_message_id"]
    }
  }
}
```

Response rows: `{"groupings": {"campaign_id": ..., "campaign_message_id": ...}, "statistics": {...}}`
— one row per variation, giving us exactly the per-variation click/conversion breakdown needed.

## Unverified — requires a live-account test before final implementation

- Whether `GET /api/metrics` supports a direct server-side `equals(name,'Placed Order')` filter,
  or only `integration.name`/`integration.category` — plan for the safe case (fetch the list,
  filter client-side) unless Phase 1 discovery shows a working name filter.
- Whether `Delete Campaign Message` truly doesn't exist anywhere in the API (a 404 on the guessed
  URL plus no hits in search — suggestive, not exhaustively proven). Doesn't block v1 since the
  design doesn't rely on deleting anything anyway.
- Exact scope required by `POST /api/campaign-send-jobs` — assumed `campaigns:write` by convention
  with every other write operation in this table; confirm against the real key's rejected/accepted
  behavior in Phase 6 testing before relying on it.
- Whether `recipients`/sample-count statistics are populated the way expected for a completed A/B
  test specifically (vs. a plain campaign) — confirm against a real completed EN test in Phase 1.
- The exact structure of your existing language-campaign drafts (single primary message vs.
  two-message A/B-style structure) — resolves DESIGN.md §7's open branch; needs a real campaign
  inspected, read-only, in Phase 1.
