// Per-language-campaign validation — DESIGN.md §6 / original spec §10.
// Checks 12/13 (idempotency: "no prior execution for this family+language") and 14 (content-hash
// drift since discovery) need the Postgres state store, which isn't wired up until Phase 4 —
// they're stubbed here with an explicit NOT_IMPLEMENTED marker rather than silently skipped, so
// nothing downstream can mistake "not checked yet" for "checked and passed."

const NOT_YET_IMPLEMENTED = ["idempotency_no_prior_execution", "no_duplicate_send", "content_unchanged_since_discovery"];

export function validateLanguageCampaign({ campaign, messages, expectedLangCode }) {
  const failures = [];
  const attrs = campaign.attributes || {};

  if (attrs.status !== "Draft") {
    failures.push({ check: "status_is_draft", detail: `status is "${attrs.status}", expected "Draft"` });
  }
  if (["Scheduled", "Sending", "Sent"].includes(attrs.status) || String(attrs.status).startsWith("Cancelled")) {
    failures.push({ check: "not_already_scheduled_or_sent", detail: `status "${attrs.status}" indicates this campaign is past draft` });
  }

  if (!messages || messages.length === 0) {
    failures.push({ check: "has_message", detail: "no campaign-messages found" });
  } else if (messages.length > 1) {
    // Contradicts the empirical Phase 1 finding (every real language campaign had exactly one
    // message) — treat as unexpected structure needing manual review, not something to guess at.
    failures.push({
      check: "expected_single_message",
      detail: `found ${messages.length} campaign-messages; DESIGN.md §7's PATCH-based approach assumes exactly one`,
    });
  }

  const audiences = attrs.audiences || {};
  if (!audiences.included || audiences.included.length === 0) {
    failures.push({ check: "audience_included_non_empty", detail: "audiences.included is empty" });
  }

  if (!attrs.send_options || !attrs.tracking_options) {
    failures.push({ check: "send_and_tracking_options_present", detail: "send_options or tracking_options missing" });
  }

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
