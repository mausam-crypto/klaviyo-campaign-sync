// Main cron entry point (`npm run run`, invoked every 5 minutes by the Render Cron Job).
//
// NOT YET LIVE-TESTED end-to-end — depends on a provisioned Postgres (DATABASE_URL) which does
// not exist yet as of this writing. Phase 4 in ARCHITECTURE.md's testing plan is "dry-run full
// execution"; this file is that implementation, but running it for the first time against a real
// DB is still pending. AUTOMATION_ENABLED defaults to false specifically so this can be deployed
// and iterated on safely before that first real run.
import { config } from "./config.mjs";
import { klaviyoGet } from "./klaviyoClient.mjs";
// klaviyoPatch is not yet used — the write path is intentionally blocked, see below.
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

  if (!family.tagVerified) {
    await updateExecution(execution.id, { status: "FAILED", failure_reason: "family not tag-verified — refusing write actions on a name-matched family (DESIGN.md §3)" });
    await notifyFailure({
      campaignName: campaignGroupTag,
      winner: decision.winner,
      problem: "Family identified by name only, not by group:/lang: tags",
      reason: "Write actions (removing the losing variation, scheduling) are only permitted on tag-verified families. Add group:/lang: tags to this family's campaigns to enable automation.",
    });
    return;
  }

  // WRITE PATH — BLOCKED PENDING A DESIGN DECISION, NOT YET IMPLEMENTED.
  // Verified against the raw stable OpenAPI spec (2026-09-03): there is no DELETE endpoint for a
  // single campaign-message, no PATCH/DELETE on the campaign -> campaign-messages relationship,
  // and POST /api/campaign-clone always clones every message with no subset selection. There is
  // no documented, stable way to remove one variation from a two-message campaign, even though
  // that's confirmed to be your team's real manual process today. See DESIGN.md §7 "Variation
  // selection" for the options put to you (separate single-message campaigns per language,
  // archived instead of deleted; a manual hybrid; or waiting on the 2026-10-15 beta GA) — this
  // function must not proceed until that's resolved, so it stops here rather than guessing.
  await updateExecution(execution.id, { status: "FAILED", failure_reason: "write path not implemented — no supported API removes a losing variation (see DESIGN.md §7)" });
  await notifyFailure({
    campaignName: campaignGroupTag,
    winner: decision.winner,
    problem: "Winner computed and validated, but the write path is intentionally not implemented yet",
    reason: "No documented Klaviyo API removes one variation from a two-message campaign — needs a decision, see DESIGN.md §7",
  });
  return;

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
