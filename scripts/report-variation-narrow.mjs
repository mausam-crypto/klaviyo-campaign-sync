import { klaviyoPost } from "./lib.mjs";

const EN_CAMPAIGN_ID = "01M1GGDP24GPCBEPXGFY4819K3";
const CONVERSION_METRIC_ID = "Wrf6RN";
const SEND_TIME = "2026-09-02T09:30:00+00:00";
const ONE_HOUR_LATER = "2026-09-02T10:30:00+00:00";

const report = await klaviyoPost("/campaign-values-reports", {
  data: {
    type: "campaign-values-report",
    attributes: {
      statistics: ["click_rate", "conversion_rate", "recipients"],
      timeframe: { start: SEND_TIME, end: ONE_HOUR_LATER },
      conversion_metric_id: CONVERSION_METRIC_ID,
      filter: `equals(campaign_id,"${EN_CAMPAIGN_ID}")`,
      group_by: ["campaign_id", "campaign_message_id", "variation"],
    },
  },
});
console.log(report.status, JSON.stringify(report.body, null, 2));
