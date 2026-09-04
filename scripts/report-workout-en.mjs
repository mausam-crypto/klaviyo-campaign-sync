import { klaviyoPost } from "./lib.mjs";
const CAMPAIGN_ID = "01M1BAH4HQPQKPKA61AAFDGVGJ";
const CONVERSION_METRIC_ID = "Wrf6RN";
const report = await klaviyoPost("/campaign-values-reports", {
  data: {
    type: "campaign-values-report",
    attributes: {
      statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
      timeframe: { key: "last_365_days" },
      conversion_metric_id: CONVERSION_METRIC_ID,
      filter: `equals(campaign_id,"${CAMPAIGN_ID}")`,
      group_by: ["campaign_id", "campaign_message_id", "variation"],
    },
  },
});
console.log(report.status, JSON.stringify(report.body, null, 2));
