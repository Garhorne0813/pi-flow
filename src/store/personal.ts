import type { Store } from "../store.js";
import type { State } from "../domain.js";
import type { Registry } from "./registry.js";
const keys = [
  "agents",
  "managedAgents",
  "skills",
  "mcp",
  "policy",
  "configRevisions",
  "modelCatalog",
] as const;
// The existing execution engine consumes State. Overlay platform-owned registry
// records at the boundary; user writes never copy platform configuration.
export function personalStore(backing: Store, registry: Registry): Store {
  const overlay = async (fn: (s: State) => unknown) => {
    return async (s: State) => {
      // Read live policy after the backing store has acquired its locks. A
      // policy snapshot taken before waiting could authorize a revoked tool.
      const global = await registry.read((s) =>
        Object.fromEntries(keys.map((k) => [k, s[k]])),
      );
      const original = Object.fromEntries(keys.map((k) => [k, s[k]]));
      Object.assign(s, structuredClone(global));
      try {
        return await fn(s);
      } finally {
        Object.assign(s, original);
      }
    };
  };
  return new Proxy(backing, {
    get(target, key) {
      if (key === "workspaceTx" && target.workspaceTx)
        return async (user: string, fn: (s: State) => unknown) =>
          target.workspaceTx!(user, await overlay(fn));
      if (["read", "tx"].includes(String(key)))
        return async (user: string, fn: (s: State) => unknown) =>
          target[key as "read" | "tx"](user, await overlay(fn));
      if (key === "txLight" && target.txLight)
        return async (
          user: string,
          sid: string,
          fn: (s: State) => unknown,
          idempotencyKey?: string,
        ) => target.txLight!(user, sid, await overlay(fn), idempotencyKey);
      if ((key === "runTx" || key === "claimRun") && target[key])
        return async (user: string, rid: string, fn: (s: State) => unknown) =>
          target[key]!(user, rid, await overlay(fn));
      if (key === "scheduleTx" && target.scheduleTx)
        return async (user: string, sid: string, fn: (s: State) => unknown) =>
          target.scheduleTx!(user, sid, await overlay(fn));
      if (key === "readRun")
        return async (
          user: string,
          rid: string,
          fn: (s: State) => unknown,
          entries?: boolean,
        ) => target.readRun(user, rid, await overlay(fn), entries);
      if (key === "readMetadata")
        return async (
          user: string,
          requested: (keyof State)[],
          fn: (s: State) => unknown,
        ) => target.readMetadata(user, requested, await overlay(fn));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
