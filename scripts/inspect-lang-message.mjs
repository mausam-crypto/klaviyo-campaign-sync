import { klaviyoGet } from "./lib.mjs";

// "fr" language campaign in the "Why the order of your skincare can matter" family
const CAMPAIGN_ID = "01M1K1R5C8033HR1XCD3G3R8QJ";

const res = await klaviyoGet(
  `/campaigns/${CAMPAIGN_ID}/campaign-messages?fields[campaign-message]=definition,created_at,updated_at`
);
console.log(res.status, JSON.stringify(res.body, null, 2));
