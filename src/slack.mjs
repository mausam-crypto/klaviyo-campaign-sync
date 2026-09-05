import { config } from "./config.mjs";

async function post(text) {
  if (config.dryRun) {
    console.log("[DRY RUN] would post to Slack:\n" + text);
    return;
  }
  if (!config.slackWebhookUrl) {
    console.log("[Slack notification, not sent — no SLACK_WEBHOOK_URL configured]\n" + text);
    return;
  }
  const res = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error(`Slack notification failed: ${res.status}`);
  }
}

/**
 * The automation stops here (DESIGN.md §7): it computes and validates the winner, but does not
 * delete a message or send anything itself — no Klaviyo API can remove one message from a
 * two-message campaign or send only one of them. This notification is the handoff to a human:
 * exactly which message to delete and which campaign to send, per language.
 */
export async function notifyWinnerReady({ campaignName, winner, clickRateA, clickRateB, placedOrderRateA, placedOrderRateB, decidedBy, languageResults }) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  const decidedByText = decidedBy === "click_rate_tiebreak"
    ? "Click Rate (conversion rates were exactly tied)"
    : "Placed Order Rate (conversion) — the primary metric";

  const lines = languageResults
    .map((r) => `  • *${r.lang}* — campaign \`${r.campaignId}\`: delete message \`${r.deleteMessageId}\`, keep+send \`${r.keepMessageId}\``)
    .join("\n");

  await post(
    `:large_yellow_circle: *Klaviyo Campaign Automation — Winner Ready, Action Needed*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      `*Winner:* Variation ${winner}\n` +
      `*Decided by:* ${decidedByText}\n\n` +
      `*Placed Order Rate:* A = ${pct(placedOrderRateA)}, B = ${pct(placedOrderRateB)}\n` +
      `*Click Rate:* A = ${pct(clickRateA)}, B = ${pct(clickRateB)}\n\n` +
      `*Action needed — for each of the ${languageResults.length} language campaigns below, delete the losing message and send:*\n${lines}\n\n` +
      `Once sent, the automation will confirm completion automatically on its next run.`
  );
}

/**
 * Dual-campaign structure only (DESIGN.md §7, decided 2026-09-05): the automation itself
 * scheduled the winning single-message campaign and archived the losing one for every language —
 * no human action needed. Distinct from notifyCompletion, which confirms a *human's* manual
 * action under the legacy structure.
 */
export async function notifyAutomatedSuccess({ campaignName, winner, clickRateA, clickRateB, placedOrderRateA, placedOrderRateB, decidedBy, languageCount }) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  const decidedByText = decidedBy === "click_rate_tiebreak"
    ? "Click Rate (conversion rates were exactly tied)"
    : "Placed Order Rate (conversion) — the primary metric";
  await post(
    `:white_check_mark: *Klaviyo Campaign Automation Completed*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      `*Winner:* Variation ${winner}\n` +
      `*Decided by:* ${decidedByText}\n\n` +
      `*Placed Order Rate:* A = ${pct(placedOrderRateA)}, B = ${pct(placedOrderRateB)}\n` +
      `*Click Rate:* A = ${pct(clickRateA)}, B = ${pct(clickRateB)}\n\n` +
      `${languageCount} language campaigns scheduled for 10:00 AM recipient local time, losing ` +
      `variant archived in each. No action needed.\n\n` +
      `*Status:* SUCCESS`
  );
}

/** Sent once a prior notifyWinnerReady's languages are all confirmed sent (src/run.mjs's
 *  verification pass) — closes the loop so the audit trail shows the family actually finished. */
export async function notifyCompletion({ campaignName, winner, languageCount }) {
  await post(
    `:white_check_mark: *Klaviyo Campaign Automation Completed*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      `*Winner:* Variation ${winner}\n` +
      `${languageCount} language campaigns confirmed sent.\n\n` +
      `*Status:* SUCCESS`
  );
}

/** Sent if a language campaign was sent but the remaining message doesn't match the computed
 *  winner — someone (or something) sent the wrong variation. Needs eyes, not auto-resolution. */
export async function notifyMismatch({ campaignName, lang, campaignId, expectedMessageId }) {
  await post(
    `:rotating_light: *Klaviyo Campaign Automation — Mismatch Detected*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      `*Language:* ${lang} (campaign \`${campaignId}\`)\n` +
      `This campaign was sent, but the remaining message doesn't match the computed winner ` +
      `(expected \`${expectedMessageId}\`). Please double-check what actually went out.`
  );
}

export async function notifyFailure({ campaignName, winner, problem, reason }) {
  await post(
    `:x: *Klaviyo Campaign Automation FAILED*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      (winner ? `*Winner:* ${winner}\n` : "") +
      `*Problem:* ${problem}\n` +
      (reason ? `*Reason:* ${reason}\n` : "") +
      `*Action:* NO language campaigns were sent.`
  );
}
