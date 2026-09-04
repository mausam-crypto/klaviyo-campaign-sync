// Main cron entry point (`npm run run`, invoked every 5 minutes by the Render Cron Job).
//
// NOT YET LIVE-TESTED end-to-end — depends on a provisioned Postgres (DATABASE_URL) which does
// not exist yet as of this writing. Phase 4 in ARCHITECTURE.md's testing plan is "dry-run full
// execution"; this file is that implementation, but running it for the first time against a real
// DB is still pending. AUTOMATION_ENABLED defaults to false specifically so this can be deployed
// and iterated on safely before that first real run.
import { config } from "./config.mjs";
import { klaviyoGet, klaviyoPatch, klaviyoPost } from "./klaviyoClient.mjs";
import { lookupPlacedOrderMetricId } from "./metrics.mjs";
import { fetchVariationStats } from "./reporting.mjs";
import { classifySnapshot, decideWinner } from "./winner.mjs";
import { groupCampaignsByFamily, checkFamilyCompleteness } from "./family.mjs";
import { validateDualCampaignLanguage } from "./validate.mjs";
import { findExecution, createOrGetExecution, updateExecution, isCampaignExcluded, recordHeartbeat } from "./db.mjs";
import { notifySuccess, notifyFailure } from "./slack.mjs";

/**
 * UNVERIFIED, needs Phase 5 (controlled test campaign) confirmation before this ever runs for
 * real: what calendar date to target for the "10 AM recipient local time" send. Heuristic below —
 * same UTC calendar day if there's still enough runway before 10 AM could plausibly have passed
 * in every timezone, otherwise the next day. Not something to trust without a real dry run.
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
    decided_by: decision.decidedBy, // 'conversion_rate' | 'click_rate_tiebreak'
  });

  if (!family.tagVerified) {
    // Legacy (name-matched, one-campaign-two-message) families can never reach the write path —
    // there's no supported API to remove one message from that structure (DESIGN.md §7). Report
    // and stop rather than guess.
    await updateExecution(execution.id, { status: "FAILED", failure_reason: "family not tag-verified — refusing write actions on a name-matched, legacy-structure family (DESIGN.md §3/§7)" });
    await notifyFailure({
      campaignName: campaignGroupTag,
      winner: decision.winner,
      problem: "Family identified by name only (legacy single-campaign structure), not tag-verified dual campaigns",
      reason: "Write actions only run on dual_campaign families built with group:/lang:/variant: tags. Rebuild this family's language campaigns as two tagged single-message campaigns per language to enable automation.",
    });
    return;
  }

  // Validate every language's TWO campaigns (Variant A / Variant B) — all-or-nothing per
  // DESIGN.md §6/§10. Only dual_campaign families reach here (gate above).
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

  // Write path — schedule the winning variant's campaign, archive the losing one. Guarded by
  // klaviyoClient's dry-run/automation-enabled check; nothing below actually reaches Klaviyo
  // unless both AUTOMATION_ENABLED=true and DRY_RUN=false. NOT YET RUN FOR REAL — needs Phase 5
  // (controlled test campaign) before this touches a real send. See computeTargetSendDate()'s
  // doc comment for the biggest open unknown (exact send-date heuristic).
  const targetDate = computeTargetSendDate();
  for (const { lang, slot } of languageResults) {
    const winnerCampaign = decision.winner === "A" ? slot.a : slot.b;
    const loserCampaign = decision.winner === "A" ? slot.b : slot.a;

    await klaviyoPatch(`/campaigns/${winnerCampaign.id}`, {
      data: {
        type: "campaign",
        id: winnerCampaign.id,
        attributes: {
          send_strategy: {
            method: "static",
            options: { datetime: `${targetDate}T10:00:00`, is_local: true, send_past_recipients_immediately: false },
          },
        },
      },
    });
    await klaviyoPost("/campaign-send-jobs", {
      data: { type: "campaign-send-job", id: winnerCampaign.id },
    });
    await klaviyoPatch(`/campaigns/${loserCampaign.id}`, {
      data: { type: "campaign", id: loserCampaign.id, attributes: { archived: true } },
    });
    console.log(`[${campaignGroupTag}] ${lang}: scheduled variant ${decision.winner} (${winnerCampaign.id}), archived the other (${loserCampaign.id})`);
  }

  await updateExecution(execution.id, { status: "SUCCESS" });
  await notifySuccess({
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
