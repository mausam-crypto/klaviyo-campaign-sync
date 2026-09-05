// Per-language-campaign validation — DESIGN.md §6 / original spec §10.
//
// Two shapes exist, matching src/family.mjs's `structure` field:
//  - `legacy_single_campaign`: one campaign per language, two messages inside — every
//    already-sent real campaign in the account looks like this. `validateLanguageCampaign()`
//    below. Read-only reporting only; there's no supported Klaviyo API to remove one message
//    from this shape (DESIGN.md §7), so it never reaches the write path.
//  - `dual_campaign` (decided 2026-09-05): two single-message campaigns per language, named
//    "<subject> (xx) (a)" / "<subject> (xx) (b)". `validateDualCampaignLanguage()` below — the
//    only structure the write path (src/run.mjs) acts on.
//
// Checks 12/13 (idempotency: "no prior execution for this family+language") and 14 (content-hash
// drift since discovery) need the Postgres state store, which isn't wired up until Phase 4 —
// they're stubbed here with an explicit NOT_IMPLEMENTED marker rather than silently skipped, so
// nothing downstream can mistake "not checked yet" for "checked and passed."

const NOT_YET_IMPLEMENTED = ["idempotency_no_prior_execution", "no_duplicate_send", "content_unchanged_since_discovery"];

/** Matches campaign-messages to "A"/"B" by their `label` text, the same durable-ish signal EN
 *  campaign-messages use ("... Variation A" / "... Variation B"). See src/family.mjs and
 *  DESIGN.md §8 for why this is label-based, not order-based — and why it's still only a
 *  display-text signal, cross-checked here by requiring both to be found, not assumed. */
export function identifyVariationMessages(messages) {
  const byLabel = (suffix) =>
    messages.find((m) => new RegExp(`variation\\s*${suffix}\\s*$`, "i").test(m.attributes?.definition?.label || ""));
  return { messageA: byLabel("a"), messageB: byLabel("b") };
}

export function validateLanguageCampaign({ campaign, messages, expectedLangCode }) {
  const failures = [];
  const attrs = campaign.attributes || {};

  if (attrs.status !== "Draft") {
    failures.push({ check: "status_is_draft", detail: `status is "${attrs.status}", expected "Draft"` });
  }
  if (["Scheduled", "Sending", "Sent"].includes(attrs.status) || String(attrs.status).startsWith("Cancelled")) {
    failures.push({ check: "not_already_scheduled_or_sent", detail: `status "${attrs.status}" indicates this campaign is past draft` });
  }

  // Confirmed directly by you (2026-09-03): language drafts really do carry both A and B
  // messages, with the losing one manually deleted once the winner's known — the "always exactly
  // one message" read from live data during discovery was just campaigns caught after that
  // manual deletion already happened, not the true pre-decision shape. Validate for two.
  if (!messages || messages.length !== 2) {
    failures.push({
      check: "has_both_variations",
      detail: `found ${messages?.length ?? 0} campaign-messages, expected exactly 2 (Variation A + Variation B)`,
    });
  } else {
    const identified = identifyVariationMessages(messages);
    if (!identified.messageA || !identified.messageB) {
      failures.push({
        check: "variations_identifiable",
        detail: `could not identify both "Variation A" and "Variation B" by label among: ${messages.map((m) => JSON.stringify(m.attributes?.definition?.label)).join(", ")}`,
      });
    }
  }

  const audiences = attrs.audiences || {};
  if (!audiences.included || audiences.included.length === 0) {
    failures.push({ check: "audience_included_non_empty", detail: "audiences.included is empty" });
  }

  if (!attrs.send_options || !attrs.tracking_options) {
    failures.push({ check: "send_and_tracking_options_present", detail: "send_options or tracking_options missing" });
  }

  // UNVERIFIED: every campaign inspected during Phase 1 already had send_strategy configured,
  // but all of those were past Draft (already scheduled/sent) — we haven't yet confirmed whether
  // a language campaign in true pre-decision Draft state already has send_strategy set to
  // static/10am/local, or whether that's only added at the final scheduling step. If it turns
  // out to be the latter, this check needs to move from "validate" to "part of what scheduling
  // sets," not something a still-undecided draft is expected to already satisfy.
  const strategy = attrs.send_strategy;
  if (!strategy || strategy.method !== "static") {
    failures.push({ check: "send_strategy_is_static", detail: `send_strategy.method is "${strategy?.method}", expected "static" for a scheduled single send` });
  } else {
    if (strategy.options?.is_local !== true) {
      failures.push({ check: "local_timezone_send_enabled", detail: "send_strategy.options.is_local is not true — will not send at 10 AM recipient local time" });
    }
    const timeOfDay = strategy.datetime ? strategy.datetime.slice(11, 16) : null;
    if (timeOfDay !== "10:00") {
      failures.push({ check: "scheduled_time_is_10am", detail: `send_strategy.datetime time-of-day is "${timeOfDay}", expected "10:00"` });
    }
  }

  for (const check of NOT_YET_IMPLEMENTED) {
    failures.push({ check, detail: "not implemented until Phase 4 (Postgres state store)", blocking: false });
  }

  const blockingFailures = failures.filter((f) => f.blocking !== false);
  return { passed: blockingFailures.length === 0, failures, langCode: expectedLangCode };
}

function validateSingleCampaign(campaign, label) {
  const failures = [];
  const attrs = campaign?.attributes || {};

  if (!campaign) {
    failures.push({ check: `${label}_exists`, detail: `Variant ${label} campaign not found` });
    return failures; // nothing else is checkable without a campaign object
  }
  if (attrs.status !== "Draft") {
    failures.push({ check: `${label}_status_is_draft`, detail: `status is "${attrs.status}", expected "Draft"` });
  }
  if (["Scheduled", "Sending", "Sent"].includes(attrs.status) || String(attrs.status).startsWith("Cancelled")) {
    failures.push({ check: `${label}_not_already_scheduled_or_sent`, detail: `status "${attrs.status}" indicates this campaign is past draft` });
  }
  if ((campaign._messages || []).length !== 1) {
    failures.push({ check: `${label}_has_single_message`, detail: `found ${(campaign._messages || []).length} campaign-messages, expected exactly 1 under the dual-campaign structure` });
  }
  if (!attrs.audiences?.included?.length) {
    failures.push({ check: `${label}_audience_included_non_empty`, detail: "audiences.included is empty" });
  }
  if (!attrs.send_options || !attrs.tracking_options) {
    failures.push({ check: `${label}_send_and_tracking_options_present`, detail: "send_options or tracking_options missing" });
  }
  return failures;
}

/**
 * Validates a language's TWO campaigns (Variant A / Variant B) under the dual-campaign
 * structure. Both must independently pass, and — critical, since these two campaigns are meant
 * to be the same recipients seeing different content — their audiences must match exactly.
 * Whichever one turns out to be the loser gets `archived: true` (not deleted) by the write path;
 * nothing here decides that — this only validates that both are safe to act on.
 */
export function validateDualCampaignLanguage({ campaignA, campaignB, expectedLangCode }) {
  const failures = [
    ...validateSingleCampaign(campaignA, "a"),
    ...validateSingleCampaign(campaignB, "b"),
  ];

  if (campaignA && campaignB) {
    const audA = campaignA.attributes?.audiences?.included || [];
    const audB = campaignB.attributes?.audiences?.included || [];
    const sameAudience = audA.length === audB.length && audA.every((id) => audB.includes(id));
    if (!sameAudience) {
      failures.push({
        check: "same_audience_both_variants",
        detail: `Variant A audience (${JSON.stringify(audA)}) does not match Variant B audience (${JSON.stringify(audB)})`,
      });
    }
  }

  for (const check of NOT_YET_IMPLEMENTED) {
    failures.push({ check, detail: "not implemented until Phase 4 (Postgres state store)", blocking: false });
  }

  const blockingFailures = failures.filter((f) => f.blocking !== false);
  return { passed: blockingFailures.length === 0, failures, langCode: expectedLangCode };
}
