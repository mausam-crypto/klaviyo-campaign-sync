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
    // One side reporting zero while the other has data is not the expected "clean, balanced
    // test" shape, but it's also not the classic contamination signature (both non-trivial,
    // wildly unequal). Treat conservatively as not-yet-clean rather than guessing which case it is.
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
 * The deterministic winner algorithm from DESIGN.md §4. Click Rate is the primary metric;
 * Placed Order Rate can override it, but only when the higher-conversion variation's rate is at
 * least conversionOverrideThreshold (default 10%) RELATIVELY higher than the other's. Returns
 * either a decision or a STOP with an explicit reason — never a silent guess.
 */
export function decideWinner(a, b) {
  const stop = (reason) => ({ winner: null, stop: true, reason });

  for (const [label, v] of [["A", a], ["B", b]]) {
    if (!v) return stop(`missing metrics for variation ${label}`);
    if (v.recipients == null || v.recipients === 0) return stop(`zero or missing recipients for variation ${label}`);
    if (v.clickRate == null) return stop(`missing click_rate for variation ${label}`);
    if (v.conversionRate == null) return stop(`missing conversion_rate (Placed Order) for variation ${label}`);
  }

  let clickWinner = null; // "A" | "B" | "TIE"
  if (a.clickRate === b.clickRate) clickWinner = "TIE";
  else clickWinner = a.clickRate > b.clickRate ? "A" : "B";

  if (clickWinner === "TIE" && a.conversionRate === b.conversionRate) {
    return stop("exact tie on both click rate and conversion rate — no safe default");
  }

  const higherConvLabel = a.conversionRate > b.conversionRate ? "A" : "B";
  const higherConv = higherConvLabel === "A" ? a : b;
  const lowerConv = higherConvLabel === "A" ? b : a;

  let relDiff;
  if (lowerConv.conversionRate === 0) {
    relDiff = higherConv.conversionRate > 0 ? Infinity : 0;
  } else {
    relDiff = (higherConv.conversionRate - lowerConv.conversionRate) / lowerConv.conversionRate;
  }

  const overrideTriggers = relDiff >= config.conversionOverrideThreshold;

  let winner, decidedBy;
  if (overrideTriggers) {
    winner = higherConvLabel;
    decidedBy = "conversion_override";
  } else if (clickWinner === "TIE") {
    return stop("click rate tied and conversion difference below threshold — no deterministic winner");
  } else {
    winner = clickWinner;
    decidedBy = "click_rate";
  }

  return {
    winner,
    stop: false,
    decidedBy,
    conversionDiffRatio: relDiff,
    overrideTriggered: overrideTriggers,
    clickRateA: a.clickRate,
    clickRateB: b.clickRate,
    conversionRateA: a.conversionRate,
    conversionRateB: b.conversionRate,
  };
}
