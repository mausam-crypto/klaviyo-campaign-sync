// Phase 3 — dry-run language matching + validation against LIVE data (read-only GETs only).
import { klaviyoGet } from "../src/klaviyoClient.mjs";
import { groupCampaignsByFamily, checkFamilyCompleteness } from "../src/family.mjs";
import { validateLanguageCampaign } from "../src/validate.mjs";

async function listRecentEmailCampaigns() {
  const res = await klaviyoGet(
    "/campaigns?" +
      new URLSearchParams({
        filter: "equals(messages.channel,'email')",
        include: "campaign-messages,tags",
        sort: "-created_at",
        "page[size]": "50",
        "fields[campaign]": "name,status,archived,send_strategy,audiences,send_options,tracking_options",
        "fields[campaign-message]": "definition",
      }).toString()
  );
  if (!res.ok) throw new Error(`Failed to list campaigns: ${res.status}`);

  const included = new Map();
  for (const item of res.body.included || []) included.set(`${item.type}:${item.id}`, item);

  return (res.body.data || []).map((c) => ({
    ...c,
    _messages: (c.relationships?.["campaign-messages"]?.data || [])
      .map((ref) => included.get(`${ref.type}:${ref.id}`))
      .filter(Boolean),
  }));
}

async function main() {
  const campaigns = await listRecentEmailCampaigns();
  const families = groupCampaignsByFamily(campaigns);

  console.log(`Found ${families.size} candidate families in the 50 most recent email campaigns.\n`);

  for (const family of families.values()) {
    if (!family.en) continue; // only interested in families that include an EN campaign
    const completeness = checkFamilyCompleteness(family);

    console.log("=".repeat(70));
    console.log(`Family: "${family.baseName}"`);
    console.log(`  EN campaign: ${family.en.id} (status: ${family.en.attributes?.status})`);
    console.log(`  Languages found: ${[...family.languages.keys()].sort().join(", ") || "(none)"}`);
    console.log(`  Complete (all 14 expected languages, no conflicts): ${completeness.complete}`);
    if (completeness.missing.length) console.log(`  MISSING: ${completeness.missing.join(", ")}`);
    if (completeness.unexpected.length) console.log(`  UNEXPECTED extra languages: ${completeness.unexpected.join(", ")}`);
    if (completeness.enConflict) console.log(`  WARNING: multiple "(en)" campaigns share this base name — ambiguous, would STOP`);
    if (completeness.languageConflicts.length) console.log(`  WARNING: duplicate language campaigns for: ${completeness.languageConflicts.join(", ")}`);

    if (!completeness.complete) {
      console.log("  => Per DESIGN.md §10 default policy: STOP THE ENTIRE FAMILY. No language campaign would be touched.\n");
      continue;
    }

    console.log("\n  Per-language validation:");
    for (const [lang, campaign] of [...family.languages.entries()].sort()) {
      const result = validateLanguageCampaign({ campaign, messages: campaign._messages, expectedLangCode: lang });
      const blocking = result.failures.filter((f) => f.blocking !== false);
      console.log(`    ${lang}: ${result.passed ? "PASS" : "FAIL"} (campaign ${campaign.id})`);
      for (const f of blocking) {
        console.log(`      - ${f.check}: ${f.detail}`);
      }
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
