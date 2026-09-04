// Campaign-family / language identification — DESIGN.md §3.
//
// RISK, READ BEFORE CHANGING: every campaign in this account currently has empty tags
// (verified during Phase 1 discovery, 2026-09-03 — 50 most recent campaigns, all `tags: []`).
// The tag-based approach recommended in DESIGN.md §3 (`group:<slug>` + `lang:<code>`) is NOT yet
// in use, so this module implements the NAME-BASED FALLBACK explicitly as an interim measure,
// with its risks called out inline rather than silently assumed. Once tags are adopted, family
// matching should switch to filtering campaigns by the `group:` tag and reading `lang:` tags —
// this module's `matchFamilyByName` should then become the cross-check, not the primary source.
//
// Risks of name-based matching (per your own instruction to document them, not just accept them):
// - Two unrelated campaigns could share a subject line (e.g. a re-run of a seasonal email).
// - A language suffix could be typed inconsistently ("(en)" vs "(EN)" vs "(en-us)").
// - A subject line retyped slightly differently per language (translation drift) breaks the
//   "same base name" assumption entirely — there is no guarantee translators keep the base
//   English string identifiable across all 14 languages.

const LANGUAGE_SUFFIX = /\s*\(([a-z]{2})\)\s*$/i;

/** Splits "Some subject (fr)" into { baseName: "Some subject", langCode: "fr" }. Returns null if
 *  the name doesn't end in a recognized "(xx)" language suffix. */
export function parseCampaignName(name) {
  const match = LANGUAGE_SUFFIX.exec(name || "");
  if (!match) return null;
  return {
    baseName: name.slice(0, match.index).trim(),
    langCode: match[1].toLowerCase(),
  };
}

/**
 * Groups a flat campaign list into families by exact base-name match (case-sensitive on
 * purpose — a base name that doesn't match byte-for-byte across languages is exactly the drift
 * risk called out above, and should surface as a missing-language validation failure rather
 * than being fuzzy-matched).
 */
export function groupCampaignsByFamily(campaigns) {
  const families = new Map(); // baseName -> { en, languages: Map<langCode, campaign> }

  for (const c of campaigns) {
    const parsed = parseCampaignName(c.attributes?.name);
    if (!parsed) continue; // no recognizable "(xx)" suffix — not part of this identification scheme
    const { baseName, langCode } = parsed;
    if (!families.has(baseName)) {
      families.set(baseName, { baseName, en: null, languages: new Map() });
    }
    const family = families.get(baseName);
    if (langCode === "en") {
      if (family.en) {
        family.enConflict = true; // more than one "(en)" campaign shares this base name — ambiguous
      }
      family.en = c;
    } else {
      if (family.languages.has(langCode)) {
        family.languageConflicts = family.languageConflicts || [];
        family.languageConflicts.push(langCode); // duplicate language for this family — ambiguous
      }
      family.languages.set(langCode, c);
    }
  }

  return families;
}

export const EXPECTED_LANGUAGES = [
  "fr", "de", "da", "sv", "fi", "nl", "it", "es", "pl", "pt", "no", "ro", "hu", "el",
];

/** Cross-checks a matched family against the expected 14-language roster. Never silently
 *  proceeds with a partial set — DESIGN.md §10 requires all 14 to independently pass. */
export function checkFamilyCompleteness(family) {
  const missing = EXPECTED_LANGUAGES.filter((lang) => !family.languages.has(lang));
  const unexpected = [...family.languages.keys()].filter((lang) => !EXPECTED_LANGUAGES.includes(lang));
  return {
    complete: missing.length === 0 && !family.enConflict && !family.languageConflicts,
    missing,
    unexpected,
    enConflict: !!family.enConflict,
    languageConflicts: family.languageConflicts || [],
  };
}
