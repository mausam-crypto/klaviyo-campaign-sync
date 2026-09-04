import { klaviyoGet } from "./klaviyoClient.mjs";

/**
 * Looks up this account's real "Placed Order" metric ID. Never hardcode this — it's
 * account-specific (verified: a generic Klaviyo doc example ID did not match this account's
 * real one). GET /api/metrics has no reliable server-side filter on display name (see
 * API_CAPABILITY_MATRIX.md §6 unverified note), so we fetch the list and match client-side.
 */
export async function lookupPlacedOrderMetricId() {
  const res = await klaviyoGet("/metrics?fields[metric]=name,integration");
  if (!res.ok) {
    throw new Error(`Failed to list metrics: ${res.status}`);
  }
  const candidates = (res.body?.data || []).filter((m) => m.attributes?.name === "Placed Order");
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one "Placed Order" metric, found ${candidates.length} — cannot proceed safely.`
    );
  }
  return candidates[0].id;
}
