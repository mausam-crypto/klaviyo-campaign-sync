// Phase 2 — read-only winner-calculation validation, per ARCHITECTURE.md's phased testing plan.
// Uses real campaign-values-reports data captured during Phase 1 discovery (2026-09-03) for two
// separate, fully-settled historical EN A/B tests. No live API calls here — these are fixtures,
// timestamped and sourced, so this script (and its output) can be re-run/reviewed without
// spending any of the Reporting API's tight quota.
import { classifySnapshot, decideWinner } from "../src/winner.mjs";

const cases = [
  {
    name: 'Why the order of your skincare can matter (en)',
    campaignId: "01M1GGDP24GPCBEPXGFY4819K3",
    capturedAt: "2026-09-03T (Phase 1 discovery)",
    knownRealOutcome: "Klaviyo sent Variation A to the remaining 80% (A ended with ~90% of recipients)",
    a: { clickRate: 0.00569, conversionRate: 0.00056, recipients: 50313 },
    b: { clickRate: 0.00502, conversionRate: 0.00108, recipients: 5587 },
  },
  {
    name: "Why does your skin feel different after a workout? (en)",
    campaignId: "01M1BAH4HQPQKPKA61AAFDGVGJ",
    capturedAt: "2026-09-03T (Phase 1 discovery)",
    knownRealOutcome: "Klaviyo sent Variation B to the remaining 80% (B ended with ~90% of recipients)",
    a: { clickRate: 0.00483, conversionRate: 0.00251, recipients: 5590 },
    b: { clickRate: 0.00663, conversionRate: 0.00204, recipients: 50627 },
  },
];

console.log("Phase 2 validation — decideWinner() and classifySnapshot() against real historical data\n");

for (const c of cases) {
  console.log("=".repeat(70));
  console.log(`Campaign: ${c.name}`);
  console.log(`  id: ${c.campaignId}`);
  console.log(`  known real outcome (already sent, cannot be changed): ${c.knownRealOutcome}`);

  const classification = classifySnapshot({ recipientsA: c.a.recipients, recipientsB: c.b.recipients });
  console.log(`  snapshot classification: ${classification.classification} (${classification.reason || `ratio ${classification.ratio.toFixed(2)}`})`);

  const decision = decideWinner(c.a, c.b);
  if (decision.stop) {
    console.log(`  decideWinner() result: STOP — ${decision.reason}`);
  } else {
    console.log(`  decideWinner() result: ${decision.winner} (via ${decision.decidedBy})`);
  }

  if (classification.classification === "CONTAMINATED") {
    console.log(
      "  => THIS IS THE EXPECTED, CORRECT BEHAVIOR FOR THIS FIXTURE: this snapshot is " +
        "post-rollout data (that's what makes it useful as a historical example — the test is " +
        "long settled). In production, classifySnapshot() flagging CONTAMINATED means the " +
        "automation does NOT call decideWinner() on this data at all — it STOPs and alerts " +
        "instead. The decideWinner() line above is printed for illustration only, to show " +
        "that computing on contaminated data can disagree with Klaviyo's real, already-executed " +
        "decision — which is exactly the failure mode the classification gate exists to prevent."
    );
  }
  console.log("");
}

console.log("=".repeat(70));
console.log(
  "\nSanity checks on the algorithm itself, using synthetic clean-looking data (not from the API):"
);

const synthetic = [
  {
    label: "higher conversion rate wins outright, even against a lower click rate",
    a: { clickRate: 0.05, conversionRate: 0.01, recipients: 1000 },
    b: { clickRate: 0.048, conversionRate: 0.0115, recipients: 1000 },
    expectWinner: "B",
    expectDecidedBy: "conversion_rate",
  },
  {
    label: "higher conversion rate wins even when click rate favors the other side",
    a: { clickRate: 0.05, conversionRate: 0.0105, recipients: 1000 },
    b: { clickRate: 0.048, conversionRate: 0.01, recipients: 1000 },
    expectWinner: "A",
    expectDecidedBy: "conversion_rate",
  },
  {
    label: "conversion rate tied -> click rate breaks the tie",
    a: { clickRate: 0.05, conversionRate: 0.01, recipients: 1000 },
    b: { clickRate: 0.048, conversionRate: 0.01, recipients: 1000 },
    expectWinner: "A",
    expectDecidedBy: "click_rate_tiebreak",
  },
  {
    label: "exact tie on everything -> STOP",
    a: { clickRate: 0.05, conversionRate: 0.01, recipients: 1000 },
    b: { clickRate: 0.05, conversionRate: 0.01, recipients: 1000 },
    expectStop: true,
  },
  {
    label: "zero recipients on B -> STOP",
    a: { clickRate: 0.05, conversionRate: 0.01, recipients: 1000 },
    b: { clickRate: 0.048, conversionRate: 0.0105, recipients: 0 },
    expectStop: true,
  },
];

let allPassed = true;
for (const s of synthetic) {
  const result = decideWinner(s.a, s.b);
  let pass;
  if (s.expectStop) {
    pass = result.stop === true;
  } else {
    pass = result.winner === s.expectWinner && result.decidedBy === s.expectDecidedBy;
  }
  allPassed = allPassed && pass;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${s.label} ->`, result.stop ? `STOP (${result.reason})` : `${result.winner} via ${result.decidedBy}`);
}

console.log(allPassed ? "\nAll algorithm sanity checks passed." : "\nSOME CHECKS FAILED — do not proceed.");
