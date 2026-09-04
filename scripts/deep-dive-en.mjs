// Phase 1/2 — READ-ONLY deep dive on one real, already-completed EN A/B test campaign,
// to validate the Reporting API request shape and inspect full message content.
import { klaviyoGet, klaviyoPost } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// campaign-values-reports is rate limited to 2/minute steady — space calls out to stay safe.
const REPORT_CALL_GAP_MS = 32000;

const EN_CAMPAIGN_ID = "01M1GGDP24GPCBEPXGFY4819K3"; // "Why the order of your skincare can matter (en)"
const MSG_A = "01M1GGDP4BYNFKATAHT95A6ZKZ";
const MSG_B = "01M1GNCRHNPQ7F8YCRW5D9445V";

async function main() {
  console.log("=== Full campaign object ===");
  const campaign = await klaviyoGet(`/campaigns/${EN_CAMPAIGN_ID}`);
  console.log(campaign.status, JSON.stringify(campaign.body, null, 2));

  console.log("\n=== Full campaign-messages (unrestricted fields) ===");
  const messages = await klaviyoGet(
    `/campaigns/${EN_CAMPAIGN_ID}/campaign-messages?fields[campaign-message]=definition,send_times,created_at,updated_at`
  );
  console.log(messages.status, JSON.stringify(messages.body, null, 2));

  console.log("\n=== Metrics list (fixed pagination) ===");
  const metrics = await klaviyoGet(`/metrics?fields[metric]=name,integration`);
  console.log(metrics.status);
  const placedOrder = (metrics.body?.data || []).filter(
    (m) => m.attributes?.name === "Placed Order"
  );
  console.log("Placed Order metric candidates:", JSON.stringify(placedOrder, null, 2));

  if (placedOrder.length !== 1) {
    console.log("Not exactly one Placed Order metric found — stopping before reporting call.");
    return;
  }
  const conversionMetricId = placedOrder[0].id;

  await sleep(REPORT_CALL_GAP_MS);
  console.log("\n=== campaign-values-report: grouped by campaign_message_id ===");
  const report = await klaviyoPost("/campaign-values-reports", {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
        timeframe: { key: "last_365_days" },
        conversion_metric_id: conversionMetricId,
        filter: `equals(campaign_id,"${EN_CAMPAIGN_ID}")`,
        group_by: ["campaign_id", "campaign_message_id"],
      },
    },
  });
  console.log(report.status, JSON.stringify(report.body, null, 2));

  await sleep(REPORT_CALL_GAP_MS);
  console.log("\n=== campaign-values-report: grouped by variation ===");
  const report2 = await klaviyoPost("/campaign-values-reports", {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
        timeframe: { key: "last_365_days" },
        conversion_metric_id: conversionMetricId,
        filter: `equals(campaign_id,"${EN_CAMPAIGN_ID}")`,
        group_by: ["campaign_id", "variation"],
      },
    },
  });
  console.log(report2.status, JSON.stringify(report2.body, null, 2));

  await sleep(REPORT_CALL_GAP_MS);
  console.log("\n=== campaign-values-report: grouped by variation_name ===");
  const report3 = await klaviyoPost("/campaign-values-reports", {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
        timeframe: { key: "last_365_days" },
        conversion_metric_id: conversionMetricId,
        filter: `equals(campaign_id,"${EN_CAMPAIGN_ID}")`,
        group_by: ["campaign_id", "variation_name"],
      },
    },
  });
  console.log(report3.status, JSON.stringify(report3.body, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
