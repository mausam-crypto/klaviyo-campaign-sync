// Applies migrations/*.sql, in filename order, against DATABASE_URL. Idempotent-ish: uses
// `create table if not exists`-style safety only where the SQL itself does — for a fresh DB
// (our situation) this just runs 001_init.sql once. Reads DATABASE_URL from the environment;
// never logs the connection string itself.
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = await readFile(path.join(dir, file), "utf8");
    await pool.query(sql);
    console.log(`  done.`);
  }

  await pool.end();
  console.log("All migrations applied.");
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
