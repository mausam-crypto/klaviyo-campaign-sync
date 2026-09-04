import { klaviyoPost } from "./lib.mjs";

const EN_CAMPAIGN_ID = "01M1GGDP24GPCBEPXGFY4819K3";
const CONVERSION_METRIC_ID = "Wrf6RN"; // Placed Order, this account

const report = await klaviyoPost("/campaign-values-reports", {
  data: {
    type: "campaign-values-report",
    attributes: {
      statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
      timeframe: { key: "last_365_days" },
      conversion_metric_id: CONVERSION_METRIC_ID,
      filter: `equals(campaign_id,"${EN_CAMPAIGN_ID}")`,
      group_by: ["campaign_id", "campaign_message_id", "variation"],
    },
  },
});
console.log(report.status, JSON.stringify(report.body, null, 2));
