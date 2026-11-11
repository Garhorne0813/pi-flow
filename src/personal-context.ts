import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
// Reuse an already checked-out client for live registry reads inside a user
// transaction; otherwise a saturated pool can deadlock waiting for a second slot.
export const personalConnection = new AsyncLocalStorage<{
  pool: pg.Pool;
  client: pg.PoolClient;
}>();
