// Campaign-family / language identification — DESIGN.md §3.
//
// Two structures coexist:
//  - `legacy_single_campaign`: one campaign per language, two messages inside, named
//    "<subject> (xx)". What every already-sent real campaign in the account looks like. Kept for
//    read-only reporting only — there is no supported Klaviyo API to remove one message from
//    this shape (DESIGN.md §7), so it can never reach the write path.
//  - `dual_campaign` (decided 2026-09-05, after briefly testing and rejecting the alternative):
//    two single-message campaigns per language, named "<subject> (xx) (a)" / "<subject> (xx) (b)".
//    This is what your team builds going forward. The write path (src/run.mjs) only ever acts on
//    this structure — each campaign has exactly one message, so scheduling/sending it is
//    completely standard, well-documented Klaviyo behavior with no ambiguity about what gets sent.
//
// RISK, still true for both: every campaign in this account currently has empty tags (verified
// 2026-09-03), so both structures are identified by name, not by Klaviyo tags. Documented risks:
// - Two unrelated campaigns could share a subject line (e.g. a re-run of a seasonal email).
// - A language suffix could be typed inconsistently ("(en)" vs "(EN)" vs "(en-us)").
// - A subject line retyped slightly differently per language (translation drift) breaks the
//   "same base name" assumption entirely.
// Adopting `group:`/`lang:` Klaviyo tags remains the recommended upgrade if this becomes a real
// problem in practice — not required to start.

import { config } from "./config.mjs";

const LANGUAGE_SUFFIX = /\s*\(([a-z]{2})\)\s*$/i;
// "<subject> (fr) (a)" / "<subject> (fr) (b)" — two-letter lang code, then a/b, both in their own
// parens, at the very end. Deliberately requires BOTH parts so a plain "<subject> (fr)" (legacy)
// never matches this and vice versa.
const VARIANT_SUFFIX = /\s*\(([a-z]{2})\)\s*\(([ab])\)\s*$/i;

/** Splits "Some subject (fr)" into { baseName: "Some subject", langCode: "fr" }. Returns null if
 *  the name doesn't end in a recognized "(xx)" language suffix (including if it's actually a
 *  "(xx) (a/b)" variant name — VARIANT_SUFFIX's extra "(a|b)" isn't a valid 2-letter lang code,
 *  so this pattern doesn't accidentally match those). */
export function parseCampaignName(name) {
  const match = LANGUAGE_SUFFIX.exec(name || "");
  if (!match) return null;
  return { baseName: name.slice(0, match.index).trim(), langCode: match[1].toLowerCase() };
}

/** Splits "Some subject (fr) (a)" into { baseName: "Some subject", langCode: "fr", variant: "a" }.
 *  Returns null if the name doesn't end in the two-part "(xx) (a|b)" suffix. */
export function parseVariantCampaignName(name) {
  const match = VARIANT_SUFFIX.exec(name || "");
  if (!match) return null;
  return { baseName: name.slice(0, match.index).trim(), langCode: match[1].toLowerCase(), variant: match[2].toLowerCase() };
}

/**
 * Groups a flat campaign list into families, keyed by base subject name. Each family ends up
 * `structure: "dual_campaign"` (any of its language entries matched the "(xx) (a/b)" pattern) or
 * `"legacy_single_campaign"` (matched the plain "(xx)" pattern instead) — a family mixing both
 * within the same base name is flagged as a conflict, not silently resolved either way.
 * `family.languages.get(lang)` is `{ a, b }` under `dual_campaign`, or the campaign object
 * directly under `legacy_single_campaign`.
 */
export function groupCampaignsByFamily(campaigns) {
  const families = new Map();

  const ensureFamily = (baseName) => {
    const key = `name:${baseName}`;
    if (!families.has(key)) {
      families.set(key, { baseName, en: null, languages: new Map(), structure: null });
    }
    return families.get(key);
  };

  for (const c of campaigns) {
    const variantInfo = parseVariantCampaignName(c.attributes?.name);
    const singleInfo = variantInfo ? null : parseCampaignName(c.attributes?.name);
    if (!variantInfo && !singleInfo) continue; // no recognizable suffix — not in scope

    if (variantInfo) {
      const family = ensureFamily(variantInfo.baseName);
      if (family.structure === "legacy_single_campaign") family.structureConflict = true;
      family.structure = family.structure || "dual_campaign";

      const slot = family.languages.get(variantInfo.langCode) || { a: null, b: null };
      if (slot[variantInfo.variant]) {
        family.languageConflicts = family.languageConflicts || [];
        family.languageConflicts.push(`${variantInfo.langCode}:${variantInfo.variant}`);
      }
      slot[variantInfo.variant] = c;
      family.languages.set(variantInfo.langCode, slot);
    } else {
      const family = ensureFamily(singleInfo.baseName);
      if (singleInfo.langCode === "en") {
        if (family.en) family.enConflict = true;
        family.en = c;
        continue;
      }
      if (family.structure === "dual_campaign") family.structureConflict = true;
      family.structure = family.structure || "legacy_single_campaign";

      if (family.languages.has(singleInfo.langCode)) {
        family.languageConflicts = family.languageConflicts || [];
        family.languageConflicts.push(singleInfo.langCode);
      }
      family.languages.set(singleInfo.langCode, c);
    }
  }

  return families;
}

/** Full language roster by default; overridable (config.expectedLanguages, `EXPECTED_LANGUAGES`
 *  env var) for a smaller controlled test — see src/config.mjs. */
export function getExpectedLanguages() {
  return config.expectedLanguages;
}

/** Cross-checks a matched family against the expected language roster. Never silently proceeds
 *  with a partial set — DESIGN.md §10 requires all of them to independently pass. Under
 *  `dual_campaign`, a language only counts as present if BOTH its `a` and `b` campaigns exist. */
export function checkFamilyCompleteness(family) {
  const expected = getExpectedLanguages();
  const isDual = family.structure === "dual_campaign";
  const languagePresent = (lang) => {
    const entry = family.languages.get(lang);
    if (!entry) return false;
    return isDual ? !!(entry.a && entry.b) : true;
  };
  const missing = expected.filter((lang) => !languagePresent(lang));
  const unexpected = [...family.languages.keys()].filter((lang) => !expected.includes(lang));
  return {
    complete: missing.length === 0 && !family.enConflict && !family.languageConflicts && !family.structureConflict,
    missing,
    unexpected,
    enConflict: !!family.enConflict,
    languageConflicts: family.languageConflicts || [],
    structureConflict: !!family.structureConflict,
  };
}
