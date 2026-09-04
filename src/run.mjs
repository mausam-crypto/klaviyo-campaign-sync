// Main cron entry point (`npm run run`, invoked every 5 minutes by the Render Cron Job).
//
// NOT YET LIVE-TESTED end-to-end — depends on a provisioned Postgres (DATABASE_URL) which does
// not exist yet as of this writing. Phase 4 in ARCHITECTURE.md's testing plan is "dry-run full
// execution"; this file is that implementation, but running it for the first time against a real
// DB is still pending. AUTOMATION_ENABLED defaults to false specifically so this can be deployed
// and iterated on safely before that first real run.
import { config } from "./config.mjs";
import { klaviyoGet, klaviyoPatch } from "./klaviyoClient.mjs";
import { lookupPlacedOrderMetricId } from "./metrics.mjs";
import { fetchVariationStats } from "./reporting.mjs";
import { classifySnapshot, decideWinner } from "./winner.mjs";
import { groupCampaignsByFamily, checkFamilyCompleteness } from "./family.mjs";
import { validateLanguageCampaign } from "./validate.mjs";
import { findExecution, createOrGetExecution, updateExecution, isCampaignExcluded, recordHeartbeat } from "./db.mjs";
import { notifySuccess, notifyFailure } from "./slack.mjs";

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

  const completeness = checkFamilyCompleteness(family);
  if (!completeness.complete) {
    console.log(`[${campaignGroupTag}] incomplete family (missing: ${completeness.missing.join(", ")}) — not ready, skipping this run`);
    return;
  }

  if (!isEnTestReadyToPoll(family.en)) {
    return; // not in the polling window yet, or already past it without us — see below
  }

  const execution = existing || (await createOrGetExecution({
    campaignGroupTag,
    enCampaignId: family.en.id,
    automationVersion: config.automationVersion,
    automationEnabled: config.automationEnabled,
    dryRun: config.dryRun,
  }));

  const stats = await fetchVariationStats(family.en.id, conversionMetricId, { key: "last_365_days" });
  const messages = family.en._messages;
  if (messages.length !== 2) {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: `expected 2 EN campaign-messages, found ${messages.length}` });
    await notifyFailure({ campaignName: campaignGroupTag, problem: "EN campaign does not have exactly 2 variations" });
    return;
  }
  const [msgA, msgB] = messages;
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

  const winnerMessage = decision.winner === "A" ? msgA : msgB;
  await updateExecution(execution.id, {
    status: "WINNER_COMPUTED",
    winner_variation: decision.winner,
    winner_message_id: winnerMessage.id,
    click_rate_a: statA.clickRate, click_rate_b: statB.clickRate,
    placed_order_rate_a: statA.conversionRate, placed_order_rate_b: statB.conversionRate,
    conversion_diff_pct: decision.conversionDiffRatio,
    conversion_override: decision.overrideTriggered,
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

  // Write path — content patch + schedule. Guarded by klaviyoClient's dry-run/automation-enabled
  // check; nothing below actually reaches Klaviyo unless both AUTOMATION_ENABLED=true and
  // DRY_RUN=false.
  const winnerContent = winnerMessage.attributes?.definition?.content;
  for (const { lang, campaign } of languageResults) {
    const [message] = campaign._messages;
    await klaviyoPatch(`/campaign-messages/${message.id}`, {
      data: {
        type: "campaign-message",
        id: message.id,
        attributes: { definition: { channel: "email", content: winnerContent } },
      },
    });
    console.log(`[${campaignGroupTag}] ${lang}: content patched to winning variation`);
  }

  await updateExecution(execution.id, { status: "SUCCESS" });
  await notifySuccess({
    campaignName: campaignGroupTag,
    winner: decision.winner,
    clickRateA: statA.clickRate, clickRateB: statB.clickRate,
    placedOrderRateA: statA.conversionRate, placedOrderRateB: statB.conversionRate,
    overrideTriggered: decision.overrideTriggered,
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
