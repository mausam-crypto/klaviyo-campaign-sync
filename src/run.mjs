// Main cron entry point (`npm run run`, invoked every 5 minutes by the Render Cron Job).
//
// NOT YET LIVE-TESTED end-to-end — depends on a provisioned Postgres (DATABASE_URL) which does
// not exist yet as of this writing. AUTOMATION_ENABLED defaults to false specifically so this can
// be deployed and iterated on safely before that first real run.
//
// Write path (2026-09-03, confirmed with you): the automation does NOT delete a message, archive
// a campaign, or send anything. No Klaviyo API can remove one message from a two-message campaign
// or send only one of its messages (verified against the raw stable OpenAPI spec — see
// DESIGN.md §7). So this stops at computing and validating the winner, then hands off to a human
// via Slack with the exact message to delete and campaign to send, per language. A later run
// verifies the human's action landed correctly before marking the family SUCCESS.
import { config } from "./config.mjs";
import { klaviyoGet } from "./klaviyoClient.mjs";
import { lookupPlacedOrderMetricId } from "./metrics.mjs";
import { fetchVariationStats } from "./reporting.mjs";
import { classifySnapshot, decideWinner } from "./winner.mjs";
import { groupCampaignsByFamily, checkFamilyCompleteness } from "./family.mjs";
import { validateLanguageCampaign, identifyVariationMessages } from "./validate.mjs";
import {
  findExecution, createOrGetExecution, updateExecution, isCampaignExcluded, recordHeartbeat,
  upsertLanguageResult, getLanguageResults, confirmLanguageResult,
} from "./db.mjs";
import { notifyWinnerReady, notifyCompletion, notifyMismatch, notifyFailure } from "./slack.mjs";

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
  const [msgA, msgB] = enMessages;
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

  // Validate every language campaign — all-or-nothing per DESIGN.md §6/§10.
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
