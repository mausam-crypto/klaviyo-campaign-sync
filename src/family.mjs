// Campaign-family / language identification — DESIGN.md §3.
//
// RISK, READ BEFORE CHANGING: every campaign in this account currently has empty tags
// (verified during Phase 1 discovery, 2026-09-03 — 50 most recent campaigns, all `tags: []`).
// The tag-based approach recommended below (`group:<slug>` + `lang:<code>`) is NOT yet in use, so
// this module implements the NAME-BASED FALLBACK explicitly as an interim measure, with its risks
// called out inline rather than silently assumed.
//
// Risks of name-based matching (per your own instruction to document them, not just accept them):
// - Two unrelated campaigns could share a subject line (e.g. a re-run of a seasonal email).
// - A language suffix could be typed inconsistently ("(en)" vs "(EN)" vs "(en-us)").
// - A subject line retyped slightly differently per language (translation drift) breaks the
//   "same base name" assumption entirely — there is no guarantee translators keep the base
//   English string identifiable across all 14 languages.
//
// Structure (confirmed by you 2026-09-03, and again 2026-09-03 after briefly exploring a
// two-campaign-per-language alternative): stays at 14 language campaigns, each with BOTH
// variation messages inside. Since no Klaviyo API can remove one message or send only one from a
// two-message campaign, this project's write path stops at computing and reporting the winner —
// a human deletes the losing message and sends, same manual step as today. See DESIGN.md §7.

const LANGUAGE_SUFFIX = /\s*\(([a-z]{2})\)\s*$/i;
const GROUP_TAG = /^group:(.+)$/;
const LANG_TAG = /^lang:([a-z]{2})$/i;

/** Reads a campaign's tag names (already-`include`d tag resources) and pulls out the
 *  `group:<slug>` / `lang:<code>` pair, if present. Returns null if neither tag is set. */
export function readCampaignTags(tagNames) {
  let group = null, lang = null;
  for (const name of tagNames || []) {
    const g = GROUP_TAG.exec(name);
    if (g) group = g[1];
    const l = LANG_TAG.exec(name);
    if (l) lang = l[1].toLowerCase();
  }
  return group || lang ? { group, lang } : null;
}

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
 * Groups a flat campaign list into families. Prefers the tag-based `group:`/`lang:` convention
 * when a campaign carries those tags (`tagVerified: true`) — recommended because it's
 * deterministic, but the stakes of getting it wrong are lower now than under the earlier
 * write-capable design: a misidentified family here leads to a wrong *notification* to a human,
 * not an unattended send or delete. Still worth getting right, since a human might act on it
 * without double-checking. Everything else falls back to name matching (`tagVerified: false`).
 * A tag-based family and a name-based family are never merged.
 *
 * Expects each campaign object to carry `_tagNames` (array of this campaign's tag name strings,
 * populated by the caller from the `tags` include) alongside the usual `attributes.name`.
 */
export function groupCampaignsByFamily(campaigns) {
  const families = new Map(); // key -> { en, languages: Map<langCode, campaign>, tagVerified }

  for (const c of campaigns) {
    const tagInfo = readCampaignTags(c._tagNames);
    const nameInfo = parseCampaignName(c.attributes?.name);

    let key, langCode, tagVerified;
    if (tagInfo?.group) {
      key = `tag:${tagInfo.group}`;
      langCode = (tagInfo.lang || nameInfo?.langCode || "").toLowerCase();
      tagVerified = true;
      if (tagInfo.lang && nameInfo && tagInfo.lang !== nameInfo.langCode) {
        c._tagNameLangMismatch = true; // lang: tag disagrees with the "(xx)" name suffix
      }
    } else if (nameInfo) {
      key = `name:${nameInfo.baseName}`;
      langCode = nameInfo.langCode;
      tagVerified = false;
    } else {
      continue; // neither a group tag nor a recognizable "(xx)" suffix — not in scope
    }

    if (!families.has(key)) {
      families.set(key, { baseName: nameInfo?.baseName || tagInfo?.group, en: null, languages: new Map(), tagVerified });
    }
    const family = families.get(key);

    if (langCode === "en") {
      if (family.en) family.enConflict = true;
      family.en = c;
    } else {
      if (family.languages.has(langCode)) {
        family.languageConflicts = family.languageConflicts || [];
        family.languageConflicts.push(langCode);
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
