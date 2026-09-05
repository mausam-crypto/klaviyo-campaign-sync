import pg from "pg";
import { config } from "./config.mjs";

// DRY_RUN gates every write below (reads always execute for real — idempotency checks need
// genuine prior state even in dry-run). See ARCHITECTURE.md "Dry-run mode".
function dryRunLog(action, details) {
  console.log(`[DRY RUN] would ${action}`, JSON.stringify(details));
}

let pool;
export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
    // Render Postgres requires SSL for external connections (internal Render-network connections
    // tolerate it too) — without this, connecting from outside Render's network resets the
    // connection. rejectUnauthorized:false matches Render's self-signed setup, same as
    // scripts/migrate.mjs.
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
  if (config.dryRun) {
    dryRunLog("create execution row for", { campaignGroupTag, enCampaignId });
    return { id: `dry-run-${campaignGroupTag}`, campaign_group_tag: campaignGroupTag, poll_attempts: 0 };
  }
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
  if (config.dryRun) return dryRunLog(`update execution ${id}`, fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await getPool().query(
    `update campaign_group_executions set ${setClause}, updated_at = now() where id = $1`,
    [id, ...keys.map((k) => fields[k])]
  );
}

export async function upsertLanguageResult({ executionId, languageCode, campaignId, keepMessageId, deleteMessageId, validationStatus, validationFailures, action }) {
  if (config.dryRun) {
    dryRunLog("upsert language result for", { executionId, languageCode, campaignId, keepMessageId, deleteMessageId, action });
    return { id: `dry-run-${executionId}-${languageCode}`, keep_message_id: keepMessageId, delete_message_id: deleteMessageId };
  }
  const { rows } = await getPool().query(
    `insert into language_campaign_results
       (execution_id, language_code, campaign_id, keep_message_id, delete_message_id, validation_status, validation_failures, action)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (execution_id, language_code) do update set
       campaign_id = excluded.campaign_id,
       keep_message_id = excluded.keep_message_id,
       delete_message_id = excluded.delete_message_id,
       validation_status = excluded.validation_status,
       validation_failures = excluded.validation_failures,
       action = excluded.action
     returning *`,
    [executionId, languageCode, campaignId, keepMessageId, deleteMessageId, validationStatus, JSON.stringify(validationFailures || []), action]
  );
  return rows[0];
}

export async function getLanguageResults(executionId) {
  const { rows } = await getPool().query(
    "select * from language_campaign_results where execution_id = $1",
    [executionId]
  );
  return rows;
}

export async function confirmLanguageResult(id, action) {
  if (config.dryRun) return dryRunLog(`confirm language result ${id} as`, { action });
  await getPool().query(
    "update language_campaign_results set action = $2, confirmed_at = now() where id = $1",
    [id, action]
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
  if (config.dryRun) return dryRunLog("record heartbeat", { familiesSeen, automationEnabled });
  await getPool().query(
    "insert into run_heartbeats (families_seen, dry_run, automation_enabled) values ($1, $2, $3)",
    [familiesSeen, dryRun, automationEnabled]
  );
}
