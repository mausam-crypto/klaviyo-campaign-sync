// Phase 1 — READ-ONLY discovery. This script must never issue a POST/PATCH/DELETE.
// It exists to inspect real campaign structure before any design decision is finalized.

const API_KEY = process.env.KLAVIYO_API_KEY;
const REVISION = process.env.KLAVIYO_API_REVISION || "2026-07-15";
const BASE = "https://a.klaviyo.com/api";

if (!API_KEY) {
  console.error("KLAVIYO_API_KEY not set");
  process.exit(1);
}

async function klaviyoGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Klaviyo-API-Key ${API_KEY}`,
      revision: REVISION,
      accept: "application/json",
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(`GET ${path} -> ${res.status}`);
    console.error(JSON.stringify(body, null, 2));
    return null;
  }
  return body;
}

function summarizeCampaign(c, included) {
  const messages = (c.relationships?.["campaign-messages"]?.data || [])
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter(Boolean);
  const tags = (c.relationships?.tags?.data || [])
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter(Boolean);

  return {
    id: c.id,
    name: c.attributes?.name,
    status: c.attributes?.status,
    archived: c.attributes?.archived,
    created_at: c.attributes?.created_at,
    scheduled_at: c.attributes?.scheduled_at,
    send_time: c.attributes?.send_time,
    send_strategy: c.attributes?.send_strategy,
    audiences: c.attributes?.audiences,
    tags: tags.map((t) => t.attributes?.name),
    messages: messages.map((m) => ({
      id: m.id,
      label: m.attributes?.definition?.label,
      channel: m.attributes?.definition?.channel,
      subject: m.attributes?.definition?.content?.subject,
      send_times: m.attributes?.send_times,
    })),
  };
}

async function main() {
  console.log(`Discovery run — revision ${REVISION}, read-only\n`);

  const page = await klaviyoGet(
    "/campaigns?" +
      new URLSearchParams({
        "filter": "equals(messages.channel,'email')",
        "include": "campaign-messages,tags",
        "sort": "-created_at",
        "page[size]": "50",
        "fields[campaign]":
          "name,status,archived,created_at,scheduled_at,send_time,send_strategy,audiences",
        "fields[campaign-message]": "definition,send_times",
        "fields[tag]": "name",
      }).toString()
  );

  if (!page) {
    console.error("Failed to list campaigns — stopping.");
    return;
  }

  const included = new Map();
  for (const item of page.included || []) {
    included.set(`${item.type}:${item.id}`, item);
  }

  const summaries = (page.data || []).map((c) => summarizeCampaign(c, included));

  console.log(`Found ${summaries.length} campaigns (most recent 50, email channel).\n`);
  for (const s of summaries) {
    console.log("----------------------------------------");
    console.log(`name: ${s.name}`);
    console.log(`id: ${s.id}`);
    console.log(`status: ${s.status}`);
    console.log(`tags: ${JSON.stringify(s.tags)}`);
    console.log(`send_strategy: ${JSON.stringify(s.send_strategy)}`);
    console.log(`send_time: ${s.send_time}`);
    console.log(`audiences: ${JSON.stringify(s.audiences)}`);
    console.log(`messages: ${JSON.stringify(s.messages, null, 2)}`);
  }

  console.log("\n\n=== Metrics: looking for Placed Order ===");
  const metrics = await klaviyoGet(
    "/metrics?" +
      new URLSearchParams({
        "page[size]": "100",
        "fields[metric]": "name,integration",
      }).toString()
  );
  const placedOrder = (metrics?.data || []).filter(
    (m) => m.attributes?.name === "Placed Order"
  );
  console.log(JSON.stringify(placedOrder, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
