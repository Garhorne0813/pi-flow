import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const dir = new URL("../migrations/", import.meta.url);
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    for (const name of (await readdir(dir))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort())
      await c.query(await readFile(new URL(name, dir), "utf8"));
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
} finally {
  await p.end();
}
