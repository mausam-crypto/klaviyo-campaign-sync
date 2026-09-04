import { config } from "./config.mjs";

/**
 * Classifies a campaign-values-reports snapshot as too-early / clean / contaminated, per
 * DESIGN.md §2. This MUST run before decideWinner() is trusted — decideWinner has no way to
 * detect contamination on its own (it will happily compute a confident-looking answer from
 * biased data, which is exactly what bit us on the two real historical tests inspected during
 * discovery — see docs/VALIDATION.md).
 */
export function classifySnapshot({ recipientsA, recipientsB }) {
  const { minSampleForClassification: minSample, contaminationMaxRatio: maxRatio } = config;

  if (recipientsA == null || recipientsB == null) {
    return { classification: "TOO_EARLY", reason: "recipients missing from reporting response" };
  }
  if (recipientsA < minSample && recipientsB < minSample) {
    return { classification: "TOO_EARLY", reason: `both variations below minimum sample (${minSample})` };
  }
  if (recipientsA === 0 || recipientsB === 0) {
    return { classification: "TOO_EARLY", reason: "one variation has zero recipients" };
  }

  const ratio = Math.max(recipientsA, recipientsB) / Math.min(recipientsA, recipientsB);
  if (ratio > maxRatio) {
    return {
      classification: "CONTAMINATED",
      reason: `recipient ratio ${ratio.toFixed(2)} exceeds max ${maxRatio} — Klaviyo's rollout has likely already merged into this snapshot`,
      ratio,
    };
  }
  return { classification: "CLEAN", ratio };
}

/**
 * Winner algorithm, revised 2026-09-03 at your direction: Placed Order Rate (conversion) is now
 * the SOLE primary metric — whichever variation converts more wins, no threshold involved. Click
 * Rate only breaks an exact tie on conversion rate. This replaced an earlier click-rate-primary /
 * conversion-override design (see git history / DESIGN.md §4 for the prior version) — the old
 * 10%-relative-difference override threshold no longer applies, since conversion isn't
 * "overriding" anything anymore, it simply decides first.
 */
export function decideWinner(a, b) {
  const stop = (reason) => ({ winner: null, stop: true, reason });

  for (const [label, v] of [["A", a], ["B", b]]) {
    if (!v) return stop(`missing metrics for variation ${label}`);
    if (v.recipients == null || v.recipients === 0) return stop(`zero or missing recipients for variation ${label}`);
    if (v.conversionRate == null) return stop(`missing conversion_rate (Placed Order) for variation ${label}`);
    if (v.clickRate == null) return stop(`missing click_rate for variation ${label}`);
  }

  if (a.conversionRate !== b.conversionRate) {
    const winner = a.conversionRate > b.conversionRate ? "A" : "B";
    return {
      winner,
      stop: false,
      decidedBy: "conversion_rate",
      clickRateA: a.clickRate, clickRateB: b.clickRate,
      conversionRateA: a.conversionRate, conversionRateB: b.conversionRate,
    };
  }

  // Conversion rate tied — fall back to click rate.
  if (a.clickRate !== b.clickRate) {
    const winner = a.clickRate > b.clickRate ? "A" : "B";
    return {
      winner,
      stop: false,
      decidedBy: "click_rate_tiebreak",
      clickRateA: a.clickRate, clickRateB: b.clickRate,
      conversionRateA: a.conversionRate, conversionRateB: b.conversionRate,
    };
  }

  return stop("exact tie on both conversion rate and click rate — no safe default");
}
