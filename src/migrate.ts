import pg from "pg";
import { readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await p.query(
    await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
} finally {
  await p.end();
}
