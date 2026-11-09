import { resolve } from "node:path";
import { loadDirectoryConfig, importDirectory } from "./import.js";
import { PersonalPostgresStore } from "../personal-postgres-store.js";
import { MemoryRegistry, PostgresRegistry } from "../store/registry.js";
const tree = await loadDirectoryConfig(
  resolve(process.env.CONFIG_DIR ?? "config"),
);
if (process.argv.includes("--check")) {
  const registry = new MemoryRegistry();
  await registry.tx((s) =>
    importDirectory(s, tree, {
      tenantId: "platform",
      userId: "config-cli",
      admin: true,
    }),
  );
  console.log(`Valid configuration: ${tree.agents.length} agents`);
} else {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL required; use --check for validation only");
  const store = new PersonalPostgresStore(process.env.DATABASE_URL);
  try {
    await store.ready();
    const result = await new PostgresRegistry(store.pool).tx((s) =>
      importDirectory(
        s,
        tree,
        { tenantId: "platform", userId: "config-cli", admin: true },
        process.argv.includes("--replace"),
      ),
    );
    console.log({ revision: result.revision, agents: result.items.length });
  } finally {
    await store.close();
  }
}
