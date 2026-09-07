import { klaviyoQuery } from "./klaviyoClient.mjs";

/**
 * Per-variation click/conversion stats for one campaign. The group_by combination below was
 * found by trial against the live API — "variation" alone is rejected ("Grouping by
 * campaign_message_id is required"), and campaign_message_id alone collapses everything into one
 * aggregate row keyed by the campaign id itself. All three together is what actually breaks the
 * result out per campaign-message. See API_CAPABILITY_MATRIX.md and DESIGN.md §2 for how this was
 * verified against real data.
 *
 * campaign-values-reports is rate limited to 1/s, 2/m, 225/day (far tighter than any other
 * endpoint this project calls) — callers must not loop this across many campaigns without
 * spacing; see ARCHITECTURE.md's cron cadence notes.
 */
export async function fetchVariationStats(campaignId, conversionMetricId, timeframe) {
  const res = await klaviyoQuery("/campaign-values-reports", {
    data: {
      type: "campaign-values-report",
      attributes: {
        statistics: ["click_rate", "conversion_rate", "conversion_uniques", "recipients", "conversion_value"],
        timeframe: timeframe || { key: "last_365_days" },
        conversion_metric_id: conversionMetricId,
        filter: `equals(campaign_id,"${campaignId}")`,
        group_by: ["campaign_id", "campaign_message_id", "variation"],
      },
    },
  });

  if (!res.ok) {
    throw new Error(`campaign-values-reports failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  const rows = res.body?.data?.attributes?.results || [];
  return rows.map((row) => ({
    campaignMessageId: row.groupings.variation,
    clickRate: row.statistics.click_rate ?? null,
    conversionRate: row.statistics.conversion_rate ?? null,
    conversionUniques: row.statistics.conversion_uniques ?? null,
    recipients: row.statistics.recipients ?? null,
    conversionValue: row.statistics.conversion_value ?? null,
  }));
}
