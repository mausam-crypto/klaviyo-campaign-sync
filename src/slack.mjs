import { config } from "./config.mjs";

async function post(text) {
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

export async function notifySuccess({ campaignName, winner, clickRateA, clickRateB, placedOrderRateA, placedOrderRateB, overrideTriggered, languageCount }) {
  const pct = (n) => `${(n * 100).toFixed(2)}%`;
  await post(
    `:white_check_mark: *Klaviyo Campaign Automation Completed*\n\n` +
      `*Campaign:* ${campaignName}\n` +
      `*Winner:* Variation ${winner}\n\n` +
      `*Click Rate:* A = ${pct(clickRateA)}, B = ${pct(clickRateB)}\n` +
      `*Placed Order Rate:* A = ${pct(placedOrderRateA)}, B = ${pct(placedOrderRateB)}\n\n` +
      `*Conversion override:* ${overrideTriggered ? "Yes" : "No — difference below 10%"}\n\n` +
      `${languageCount} language campaigns processed.\n` +
      `All campaigns scheduled for 10:00 AM recipient local time.\n\n` +
      `*Status:* SUCCESS`
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
