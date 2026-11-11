import type { Store } from "./store.js";
import { Fault, type State } from "../domain/model.js";
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
      if (key === "verifyActor")
        return async (a: import("../domain/model.js").Actor) => {
          if (a.expiresAt && a.expiresAt <= Date.now())
            throw new Fault(401, "ACTOR_TOKEN_EXPIRED");
          if (!a.issuer || !a.subject) throw new Fault(403, "USER_DISABLED");
          await registry.verifyIdentity(a.issuer, a.subject, a.userId);
        };
      if (key === "sessionTx" && target.sessionTx)
        return async (
          user: string,
          sid: string | undefined,
          fn: (s: State) => unknown,
          options?: { entries?: boolean },
        ) => target.sessionTx!(user, sid, await overlay(fn), options);
      if (key === "executionTx" && target.executionTx)
        return async (
          user: string,
          rid: string,
          fn: (s: State) => unknown,
          scope?: import("./personal-execution-store.js").ExecutionScope,
        ) => target.executionTx!(user, rid, await overlay(fn), scope);
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
      if (
        ["runTx", "claimRun", "cancelTaskTx", "interactionTx"].includes(
          String(key),
        ) &&
        target[key as "runTx"]
      )
        return async (user: string, rid: string, fn: (s: State) => unknown) =>
          target[key as "runTx"]!(user, rid, await overlay(fn));
      if (key === "scheduleTx" && target.scheduleTx)
        return async (
          user: string,
          sid: string,
          fn: (s: State) => unknown,
          options?: { manualFor?: number },
        ) => target.scheduleTx!(user, sid, await overlay(fn), options);
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
        ) =>
          target.readMetadata(
            user,
            requested,
            requested.some((k) => keys.includes(k as (typeof keys)[number]))
              ? await overlay(fn)
              : fn,
          );
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
