import { klaviyoGet } from "./lib.mjs";
const CAMPAIGN_ID = "01M1BAH4HQPQKPKA61AAFDGVGJ";
const res = await klaviyoGet(`/campaigns/${CAMPAIGN_ID}/campaign-messages?fields[campaign-message]=definition`);
console.log(res.status, JSON.stringify(res.body?.data?.map(m => ({id: m.id, label: m.attributes?.definition?.label})), null, 2));
