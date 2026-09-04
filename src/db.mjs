import pg from "pg";

let pool;
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

/** Returns the existing execution row for this family, or null if never processed. This is the
 *  idempotency check called before ANY computation or write — see ARCHITECTURE.md "Idempotency". */
export async function findExecution(campaignGroupTag) {
  const { rows } = await getPool().query(
    "select * from campaign_group_executions where campaign_group_tag = $1",
    [campaignGroupTag]
  );
  return rows[0] || null;
}

export async function createOrGetExecution({ campaignGroupTag, enCampaignId, automationVersion, automationEnabled, dryRun }) {
  const { rows } = await getPool().query(
    `insert into campaign_group_executions
       (campaign_group_tag, en_campaign_id, automation_version, automation_enabled, dry_run)
     values ($1, $2, $3, $4, $5)
     on conflict (campaign_group_tag) do update set updated_at = campaign_group_executions.updated_at
     returning *`,
    [campaignGroupTag, enCampaignId, automationVersion, automationEnabled, dryRun]
  );
  return rows[0];
}

export async function updateExecution(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await getPool().query(
    `update campaign_group_executions set ${setClause}, updated_at = now() where id = $1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

export async function isCampaignExcluded(campaignGroupTag) {
  const { rows } = await getPool().query(
    "select 1 from campaign_exclusions where campaign_group_tag = $1",
    [campaignGroupTag]
  );
  return rows.length > 0;
}

export async function recordHeartbeat({ familiesSeen, dryRun, automationEnabled }) {
  await getPool().query(
    "insert into run_heartbeats (families_seen, dry_run, automation_enabled) values ($1, $2, $3)",
    [familiesSeen, dryRun, automationEnabled]
  );
}
