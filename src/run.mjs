// Main cron entry point (`npm run run`, invoked every 5 minutes by the Render Cron Job).
// AUTOMATION_ENABLED defaults to false so this can be deployed and iterated on safely.
//
// Two structures, two write paths (DESIGN.md §7 has the full back-and-forth history):
// - `dual_campaign` (current, for new sends): two single-message campaigns per language, named
//   "<subject> [xx][a]"/"[b]" (bracket suffix since 2026-09-11 — Klaviyo-side issue with "(...)"
//   in new campaign names; src/family.mjs still recognizes the older "(xx) (a)"/"(b)" form too,
//   for already-sent real campaigns only). The automation schedules the winning campaign for real (verified
//   end-to-end against a real controlled test 2026-09-07, including catching and fixing two real
//   API schema bugs and a missing write-verification gap). The losing campaign is simply left as
//   an un-sent Draft — Klaviyo's API has no way to archive a campaign, but an un-sent Draft is
//   already 100% safe, so nothing further is needed.
// - `legacy_single_campaign` (old real sends only): one campaign, two messages, no supported API
//   can isolate one message to send — this path only ever computes/validates and hands off to a
//   human via Slack, never writes to Klaviyo.
import { config } from "./config.mjs";
import { klaviyoGet, klaviyoPatch, klaviyoPost } from "./klaviyoClient.mjs";
import { lookupPlacedOrderMetricId } from "./metrics.mjs";
import { fetchVariationStats } from "./reporting.mjs";
import { classifySnapshot, decideWinner } from "./winner.mjs";
import { groupCampaignsByFamily, checkFamilyCompleteness } from "./family.mjs";
import { validateLanguageCampaign, identifyVariationMessages, validateDualCampaignLanguage } from "./validate.mjs";
import {
  findExecution, createOrGetExecution, updateExecution, isCampaignExcluded, recordHeartbeat,
  upsertLanguageResult, getLanguageResults, confirmLanguageResult,
} from "./db.mjs";
import { notifyWinnerReady, notifyCompletion, notifyMismatch, notifyFailure, notifyAutomatedSuccess } from "./slack.mjs";

/**
 * Only reached for `dual_campaign` families — each campaign here has exactly one message, so
 * scheduling/sending it is standard, well-documented Klaviyo behavior with no ambiguity about
 * what actually gets sent (unlike the legacy structure, where this was the whole blocker).
 * UNVERIFIED heuristic for which calendar date to target though: same UTC day if there's still
 * runway before 10 AM could plausibly have passed in every timezone, otherwise the next day.
 * Worth confirming against a real run before fully trusting it.
 */
function computeTargetSendDate() {
  const now = new Date();
  const cutoffUtcHour = 8; // last hour we'll still target "today" — leaves margin before 10am local anywhere
  const target = new Date(now);
  if (now.getUTCHours() >= cutoffUtcHour) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function listRecentEmailCampaigns() {
  const res = await klaviyoGet(
    "/campaigns?" +
      new URLSearchParams({
        filter: "equals(messages.channel,'email')",
        include: "campaign-messages,tags",
        sort: "-created_at",
        "page[size]": "50",
        "fields[campaign]": "name,status,send_strategy,send_time,audiences,send_options,tracking_options",
        "fields[campaign-message]": "definition",
        "fields[tag]": "name",
      }).toString()
  );
  if (!res.ok) throw new Error(`Failed to list campaigns: ${res.status}`);
  const included = new Map();
  for (const item of res.body.included || []) included.set(`${item.type}:${item.id}`, item);
  return (res.body.data || []).map((c) => ({
    ...c,
    _messages: (c.relationships?.["campaign-messages"]?.data || [])
      .map((ref) => included.get(`${ref.type}:${ref.id}`))
      .filter(Boolean),
    _tagNames: (c.relationships?.tags?.data || [])
      .map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.name)
      .filter(Boolean),
  }));
}

function isEnTestReadyToPoll(enCampaign) {
  const strategy = enCampaign.attributes?.send_strategy;
  const sendTime = enCampaign.attributes?.send_time;
  if (strategy?.method !== "ab_test_campaign" || !sendTime) return false;
  const elapsedHours = (Date.now() - new Date(sendTime).getTime()) / 3_600_000;
  return (
    elapsedHours >= config.testDurationHours * config.pollWindowStartFactor &&
    elapsedHours <= config.testDurationHours * config.pollWindowEndFactor
  );
}

/** Re-checks each language's campaign against what a human was asked to do. Never auto-corrects
 *  anything — only confirms a match or raises a mismatch alert, once per language. */
async function verifyManualCompletion(execution, family, campaignGroupTag) {
  const priorResults = await getLanguageResults(execution.id);
  let allConfirmed = true;

  for (const prior of priorResults) {
    if (prior.action === "CONFIRMED_SENT") continue; // already closed out

    const campaign = family.languages.get(prior.language_code);
    const messages = campaign?._messages || [];

    if (messages.length >= 2) {
      allConfirmed = false; // not actioned yet — normal, not an error
      continue;
    }
    if (messages.length === 0) {
      allConfirmed = false;
      continue;
    }

    const remaining = messages[0];
    if (remaining.id === prior.keep_message_id) {
      await confirmLanguageResult(prior.id, "CONFIRMED_SENT");
    } else {
      allConfirmed = false;
      if (prior.action !== "MISMATCH_DETECTED") {
        await confirmLanguageResult(prior.id, "MISMATCH_DETECTED");
        await notifyMismatch({ campaignName: campaignGroupTag, lang: prior.language_code, campaignId: prior.campaign_id, expectedMessageId: prior.keep_message_id });
      }
    }
  }

  if (allConfirmed && priorResults.length > 0) {
    await updateExecution(execution.id, { status: "SUCCESS" });
    await notifyCompletion({ campaignName: campaignGroupTag, winner: execution.winner_variation, languageCount: priorResults.length });
  }
}

async function processFamily(family, conversionMetricId) {
  const campaignGroupTag = family.baseName; // interim identifier — see src/family.mjs risk notes

  if (await isCampaignExcluded(campaignGroupTag)) {
    console.log(`[${campaignGroupTag}] excluded via campaign_exclusions — skipping`);
    return;
  }

  const existing = await findExecution(campaignGroupTag);
  if (existing?.status === "SUCCESS") {
    console.log(`[${campaignGroupTag}] already processed successfully — skipping (idempotency)`);
    return;
  }
  if (existing?.status === "AWAITING_MANUAL_ACTION") {
    await verifyManualCompletion(existing, family, campaignGroupTag);
    return;
  }
  if (existing?.status === "FAILED") {
    console.log(`[${campaignGroupTag}] previously FAILED (${existing.failure_reason}) — not retrying automatically`);
    return;
  }

  const completeness = checkFamilyCompleteness(family);
  if (!completeness.complete) {
    console.log(`[${campaignGroupTag}] incomplete family (missing: ${completeness.missing.join(", ")}) — not ready, skipping this run`);
    return;
  }

  if (!isEnTestReadyToPoll(family.en)) {
    return; // not in the polling window yet, or already past it without us
  }

  const execution = existing || (await createOrGetExecution({
    campaignGroupTag,
    enCampaignId: family.en.id,
    automationVersion: config.automationVersion,
    automationEnabled: config.automationEnabled,
    dryRun: config.dryRun,
  }));

  const stats = await fetchVariationStats(family.en.id, conversionMetricId, { key: "last_365_days" });
  const enMessages = family.en._messages;
  if (enMessages.length !== 2) {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: `expected 2 EN campaign-messages, found ${enMessages.length}` });
    await notifyFailure({ campaignName: campaignGroupTag, problem: "EN campaign does not have exactly 2 variations" });
    return;
  }
  // Identify by label ("... Variation A" / "... Variation B"), same signal used for language
  // campaigns (DESIGN.md §8) — NOT array order. Found via a controlled test (2026-09-07) where
  // this had silently trusted array order instead; real EN campaigns in this account do carry
  // proper Variation A/B labels, so this hadn't bitten anything yet, but nothing was verifying it.
  const { messageA: msgA, messageB: msgB } = identifyVariationMessages(enMessages);
  if (!msgA || !msgB) {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: `could not identify EN "Variation A"/"Variation B" by label among: ${enMessages.map((m) => JSON.stringify(m.attributes?.definition?.label)).join(", ")}` });
    await notifyFailure({ campaignName: campaignGroupTag, problem: "EN campaign-messages don't carry identifiable Variation A/B labels" });
    return;
  }
  const statA = stats.find((s) => s.campaignMessageId === msgA.id);
  const statB = stats.find((s) => s.campaignMessageId === msgB.id);

  const classification = classifySnapshot({ recipientsA: statA?.recipients, recipientsB: statB?.recipients });
  await updateExecution(execution.id, {
    poll_attempts: (execution.poll_attempts || 0) + 1,
    snapshot_recipients_a: statA?.recipients ?? null,
    snapshot_recipients_b: statB?.recipients ?? null,
    snapshot_classification: classification.classification,
  });

  if (classification.classification === "TOO_EARLY") {
    console.log(`[${campaignGroupTag}] snapshot too early, will retry next run`);
    return;
  }
  if (classification.classification === "CONTAMINATED") {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: "missed clean pre-rollout snapshot window (" + classification.reason + ")" });
    await notifyFailure({ campaignName: campaignGroupTag, problem: "Could not obtain an uncontaminated snapshot for winner computation", reason: classification.reason });
    return;
  }

  const decision = decideWinner(
    { clickRate: statA.clickRate, conversionRate: statA.conversionRate, recipients: statA.recipients },
    { clickRate: statB.clickRate, conversionRate: statB.conversionRate, recipients: statB.recipients }
  );

  if (decision.stop) {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: decision.reason });
    await notifyFailure({ campaignName: campaignGroupTag, problem: "Could not determine a safe winner", reason: decision.reason });
    return;
  }

  await updateExecution(execution.id, {
    winner_variation: decision.winner,
    click_rate_a: statA.clickRate, click_rate_b: statB.clickRate,
    placed_order_rate_a: statA.conversionRate, placed_order_rate_b: statB.conversionRate,
    decided_by: decision.decidedBy,
  });

  if (family.structure === "dual_campaign") {
    await processDualCampaignFamily({ family, campaignGroupTag, execution, decision, statA, statB });
  } else {
    await processLegacyFamily({ family, campaignGroupTag, execution, decision, statA, statB });
  }
}

/** Legacy structure (one campaign, two messages per language): validates, then hands off to a
 *  human via Slack — see module header for why this can never write to Klaviyo. */
async function processLegacyFamily({ family, campaignGroupTag, execution, decision, statA, statB }) {
  const languageResults = [];
  for (const [lang, campaign] of family.languages) {
    const result = validateLanguageCampaign({ campaign, messages: campaign._messages, expectedLangCode: lang });
    languageResults.push({ lang, campaign, result });
  }
  const anyFailed = languageResults.some((r) => !r.result.passed);
  if (anyFailed) {
    const failedLangs = languageResults.filter((r) => !r.result.passed).map((r) => r.lang);
    await updateExecution(execution.id, { status: "FAILED", failure_reason: `validation failed for: ${failedLangs.join(", ")}` });
    await notifyFailure({
      campaignName: campaignGroupTag,
      winner: decision.winner,
      problem: `${failedLangs.join(", ")} campaign(s) could not be validated`,
      reason: languageResults.find((r) => !r.result.passed).result.failures[0]?.detail,
    });
    return;
  }

  // Identify which message to keep vs delete per language, using the same label-based signal
  // as the EN campaign (DESIGN.md §8) — never array order.
  const notifyRows = [];
  for (const { lang, campaign } of languageResults) {
    const { messageA, messageB } = identifyVariationMessages(campaign._messages);
    const keep = decision.winner === "A" ? messageA : messageB;
    const del = decision.winner === "A" ? messageB : messageA;
    await upsertLanguageResult({
      executionId: execution.id,
      languageCode: lang,
      campaignId: campaign.id,
      keepMessageId: keep.id,
      deleteMessageId: del.id,
      validationStatus: "PASSED",
      validationFailures: [],
      action: "AWAITING_MANUAL_ACTION",
    });
    notifyRows.push({ lang, campaignId: campaign.id, keepMessageId: keep.id, deleteMessageId: del.id });
  }

  await updateExecution(execution.id, { status: "AWAITING_MANUAL_ACTION" });
  await notifyWinnerReady({
    campaignName: campaignGroupTag,
    winner: decision.winner,
    clickRateA: statA.clickRate, clickRateB: statB.clickRate,
    placedOrderRateA: statA.conversionRate, placedOrderRateB: statB.conversionRate,
    decidedBy: decision.decidedBy,
    languageResults: notifyRows,
  });
}

/**
 * Dual-campaign structure (two single-message campaigns per language, decided 2026-09-05): the
 * automation finishes the job itself — schedules the winner and leaves the loser exactly as it
 * is (a never-scheduled Draft, which is already 100% safe — nobody is ever emailed it; no code
 * change needed to guarantee that). Each write goes through klaviyoClient's dry-run/
 * automation-enabled guard; nothing below reaches Klaviyo unless both AUTOMATION_ENABLED=true and
 * DRY_RUN=false.
 *
 * Two real bugs, both found via the 2026-09-07 controlled test, fixed here:
 * 1. `send_strategy.datetime` must be a sibling of `options`, not nested inside it (confirmed
 *    against the live schema and against real send_strategy values already seen on real
 *    campaigns) — the nested version silently 400'd.
 * 2. `archived` is read-only via the API — not in the PATCH schema at all (confirmed against the
 *    official reference docs) — attempting to set it also silently 400'd. Dropped entirely; see
 *    above for why that's fine.
 * Both of those calls failing did NOT stop the code from calling campaign-send-jobs next, or
 * from reporting SUCCESS — that's the real defect. Fixed: every write here is checked before
 * moving on, and a failed write stops the family (not just that language) with a report of
 * exactly which languages, if any, were already actioned before the failure.
 */
async function processDualCampaignFamily({ family, campaignGroupTag, execution, decision, statA, statB }) {
  const languageResults = [];
  for (const [lang, slot] of family.languages) {
    const result = validateDualCampaignLanguage({ campaignA: slot.a, campaignB: slot.b, expectedLangCode: lang });
    languageResults.push({ lang, slot, result });
  }
  const anyFailed = languageResults.some((r) => !r.result.passed);
  if (anyFailed) {
    const failedLangs = languageResults.filter((r) => !r.result.passed).map((r) => r.lang);
    await updateExecution(execution.id, { status: "FAILED", failure_reason: `validation failed for: ${failedLangs.join(", ")}` });
    await notifyFailure({
      campaignName: campaignGroupTag,
      winner: decision.winner,
      problem: `${failedLangs.join(", ")} campaign(s) could not be validated`,
      reason: languageResults.find((r) => !r.result.passed).result.failures[0]?.detail,
    });
    return;
  }

  const targetDate = computeTargetSendDate();
  const completedLangs = [];
  for (const { lang, slot } of languageResults) {
    const winnerCampaign = decision.winner === "A" ? slot.a : slot.b;

    const scheduleRes = await klaviyoPatch(`/campaigns/${winnerCampaign.id}`, {
      data: {
        type: "campaign",
        id: winnerCampaign.id,
        attributes: {
          send_strategy: {
            method: "static",
            datetime: `${targetDate}T10:00:00`,
            options: { is_local: true, send_past_recipients_immediately: false },
          },
        },
      },
    });
    if (!scheduleRes.ok && !scheduleRes.dryRun) {
      await updateExecution(execution.id, {
        status: "FAILED",
        failure_reason: `scheduling ${lang} campaign ${winnerCampaign.id} failed: ${JSON.stringify(scheduleRes.body)}. Already completed before this: ${completedLangs.join(", ") || "none"}.`,
      });
      await notifyFailure({
        campaignName: campaignGroupTag,
        winner: decision.winner,
        problem: `Failed to schedule ${lang} campaign — stopped before sending anything for it`,
        reason: `Already completed: ${completedLangs.join(", ") || "none"}. Remaining languages were never attempted.`,
      });
      return;
    }

    const sendRes = await klaviyoPost("/campaign-send-jobs", {
      data: { type: "campaign-send-job", id: winnerCampaign.id },
    });
    if (!sendRes.ok && !sendRes.dryRun) {
      await updateExecution(execution.id, {
        status: "FAILED",
        failure_reason: `send-job for ${lang} campaign ${winnerCampaign.id} failed after it was already scheduled: ${JSON.stringify(sendRes.body)}. Already fully completed before this: ${completedLangs.join(", ") || "none"}.`,
      });
      await notifyFailure({
        campaignName: campaignGroupTag,
        winner: decision.winner,
        problem: `${lang} campaign was scheduled but the send-job failed — it will NOT send on its own, needs manual attention`,
        reason: `Already completed: ${completedLangs.join(", ") || "none"}.`,
      });
      return;
    }

    completedLangs.push(lang);
    console.log(`[${campaignGroupTag}] ${lang}: scheduled + sent variant ${decision.winner} (${winnerCampaign.id})`);
  }

  await updateExecution(execution.id, { status: "SUCCESS" });
  await notifyAutomatedSuccess({
    campaignName: campaignGroupTag,
    winner: decision.winner,
    clickRateA: statA.clickRate, clickRateB: statB.clickRate,
    placedOrderRateA: statA.conversionRate, placedOrderRateB: statB.conversionRate,
    decidedBy: decision.decidedBy,
    languageCount: languageResults.length,
  });
}

async function main() {
  if (!config.automationEnabled) {
    console.log("AUTOMATION_ENABLED is false — skipping this run entirely.");
    await recordHeartbeat({ familiesSeen: 0, dryRun: config.dryRun, automationEnabled: false }).catch(() => {});
    return;
  }

  const campaigns = await listRecentEmailCampaigns();
  const families = [...groupCampaignsByFamily(campaigns).values()].filter((f) => f.en);
  const conversionMetricId = await lookupPlacedOrderMetricId();

  for (const family of families) {
    try {
      await processFamily(family, conversionMetricId);
    } catch (err) {
      console.error(`[${family.baseName}] unhandled error`, err);
      await notifyFailure({ campaignName: family.baseName, problem: "unhandled error", reason: String(err?.message || err) }).catch(() => {});
    }
  }

  await recordHeartbeat({ familiesSeen: families.length, dryRun: config.dryRun, automationEnabled: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
