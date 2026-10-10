import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const dir = new URL("../migrations/", import.meta.url);
  await p.query("BEGIN");
  try {
    for (const name of (await readdir(dir))
      .filter((n) => /^\d+.*\.sql$/.test(n))
      .sort())
      await p.query(await readFile(new URL(name, dir), "utf8"));
    await p.query("COMMIT");
  } catch (e) {
    await p.query("ROLLBACK");
    throw e;
  }
} finally {
  await p.end();
}
