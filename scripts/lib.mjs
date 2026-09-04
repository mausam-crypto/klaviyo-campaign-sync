export const API_KEY = process.env.KLAVIYO_API_KEY;
export const REVISION = process.env.KLAVIYO_API_REVISION || "2026-07-15";
export const BASE = "https://a.klaviyo.com/api";

export async function klaviyoRequest(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Klaviyo-API-Key ${API_KEY}`,
      revision: REVISION,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

export const klaviyoGet = (path) => klaviyoRequest("GET", path);
export const klaviyoPost = (path, body) => klaviyoRequest("POST", path, body);
