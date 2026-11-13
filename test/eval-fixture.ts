import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PostgresEvalStore } from "../src/evals/postgres-store.js";
export const databaseUrl = process.env.TEST_DATABASE_URL;
export async function evalFixture() {
  const control = new pg.Pool({ connectionString: databaseUrl }),
    schema = "eval_" + randomUUID().replaceAll("-", "");
  await control.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString() });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await c.query(await readFile("migrations/" + file, "utf8"));
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  return {
    pool,
    store: new PostgresEvalStore(pool),
    url: url.toString(),
    async close() {
      await pool.end();
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    },
  };
}
