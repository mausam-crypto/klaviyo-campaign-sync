function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}
function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  klaviyoApiKey: process.env.KLAVIYO_API_KEY,
  klaviyoRevision: process.env.KLAVIYO_API_REVISION || "2026-07-15",

  // Global kill switches — see ARCHITECTURE.md "Kill switches"
  automationEnabled: bool(process.env.AUTOMATION_ENABLED, false),
  dryRun: bool(process.env.DRY_RUN, true),

  // Business rule constants — defined once, here only (DESIGN.md §4)
  conversionOverrideThreshold: num(process.env.CONVERSION_OVERRIDE_THRESHOLD, 0.10),

  // Your current native A/B config (test size 20%, 10%/10% split, 24h duration) — used only to
  // classify whether a Reporting API snapshot looks pre- or post-rollout. Not written to Klaviyo;
  // Klaviyo's own test configuration is not exposed via API (see API_CAPABILITY_MATRIX.md).
  testDurationHours: num(process.env.TEST_DURATION_HOURS, 24),
  expectedTestSplitA: num(process.env.EXPECTED_TEST_SPLIT_A, 0.10),
  expectedTestSplitB: num(process.env.EXPECTED_TEST_SPLIT_B, 0.10),

  // Snapshot classification tuning — DESIGN.md §2 "Corrected detection strategy"
  minSampleForClassification: num(process.env.MIN_SAMPLE_FOR_CLASSIFICATION, 20),
  contaminationMaxRatio: num(process.env.CONTAMINATION_MAX_RATIO, 3),
  pollWindowStartFactor: num(process.env.POLL_WINDOW_START_FACTOR, 0.5),
  pollWindowEndFactor: num(process.env.POLL_WINDOW_END_FACTOR, 1.5),

  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  automationVersion: "0.1.0",
};
