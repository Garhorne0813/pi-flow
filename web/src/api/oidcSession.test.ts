import { expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { User, UserManager } from "oidc-client-ts";
import { observeOidcSession } from "./oidcSession";
const user = (name: string) =>
  ({
    access_token: name,
    expired: false,
    profile: { iss: "https://id.example", sub: name },
  }) as User;
function setup(callback = false) {
  const events = {
    loaded: new Set<(u: User) => void>(),
    unloaded: new Set<() => void>(),
    expired: new Set<() => void>(),
  };
  let resolve!: (u: User | null) => void;
  const pending = new Promise<User | null>((r) => {
    resolve = r;
  });
  const manager = {
    events: {
      addUserLoaded: (fn: (u: User) => void) => events.loaded.add(fn),
      removeUserLoaded: (fn: (u: User) => void) => events.loaded.delete(fn),
      addUserUnloaded: (fn: () => void) => events.unloaded.add(fn),
      removeUserUnloaded: (fn: () => void) => events.unloaded.delete(fn),
      addAccessTokenExpired: (fn: () => void) => events.expired.add(fn),
      removeAccessTokenExpired: (fn: () => void) => events.expired.delete(fn),
    },
    getUser: () => pending,
    signinRedirectCallback: () => pending,
  } as unknown as Pick<
    UserManager,
    "events" | "getUser" | "signinRedirectCallback" | "settings"
  >;
  const cache = new QueryClient();
  cache.setQueryData(["identity"], { userId: "old" });
  cache.setQueryData(["sessions", 0], { items: ["old-private-session"] });
  const activate = vi.fn(),
    end = vi.fn();
  const handlers = {
    onUser: (u: User) => {
      cache.clear();
      activate(u, cache.getQueryData(["sessions", 0]));
    },
    onEnd: () => {
      cache.clear();
      end();
    },
    onRefresh: vi.fn(),
    onError: vi.fn(),
    onCallback: vi.fn(),
  };
  const dispose = observeOidcSession(manager, callback, handlers);
  return { events, resolve, cache, activate, end, handlers, dispose };
}
it.each([false, true])(
  "clears old identity and private queries before activation (callback=%s)",
  async (callback) => {
    const s = setup(callback);
    s.resolve(user("new"));
    await Promise.resolve();
    expect(s.activate).toHaveBeenCalledWith(user("new"), undefined);
    expect(s.cache.getQueryData(["identity"])).toBeUndefined();
    expect(s.handlers.onCallback).toHaveBeenCalledTimes(callback ? 1 : 0);
    s.dispose();
  },
);
it("isolates user switches, unload and expiry, and permits another login", async () => {
  const s = setup();
  s.resolve(user("a"));
  await Promise.resolve();
  s.cache.setQueryData(["sessions", 0], { items: ["a-private"] });
  s.events.loaded.forEach((fn) => fn(user("b")));
  expect(s.activate).toHaveBeenLastCalledWith(user("b"), undefined);
  s.events.expired.forEach((fn) => fn());
  expect(s.end).toHaveBeenCalledOnce();
  s.events.loaded.forEach((fn) => fn(user("c")));
  s.cache.setQueryData(["sessions", 0], { items: ["c-private"] });
  s.events.unloaded.forEach((fn) => fn());
  expect(s.cache.getQueryData(["sessions", 0])).toBeUndefined();
  expect(s.end).toHaveBeenCalledTimes(2);
  s.dispose();
});
it("does not reactivate a session from restoration after an unload event", async () => {
  const s = setup();
  s.events.unloaded.forEach((fn) => fn());
  s.resolve(user("obsolete"));
  await Promise.resolve();
  expect(s.activate).not.toHaveBeenCalled();
  s.dispose();
});
it("handles userLoaded during callback once and ignores results after disposal", async () => {
  const s = setup(true);
  const next = user("next");
  s.events.loaded.forEach((fn) => fn(next));
  s.resolve(next);
  await Promise.resolve();
  expect(s.activate).toHaveBeenCalledOnce();
  expect(s.handlers.onCallback).toHaveBeenCalledWith(next);
  s.dispose();
  const disposed = setup();
  disposed.dispose();
  disposed.resolve(user("late"));
  await Promise.resolve();
  expect(disposed.activate).not.toHaveBeenCalled();
  expect(disposed.events.loaded.size).toBe(0);
});

it("refreshes the same issuer/subject without clearing cached user state", async () => {
  const s = setup();
  s.resolve(user("a"));
  await Promise.resolve();
  s.cache.setQueryData(["sessions", 0], { items: ["private"] });
  s.events.loaded.forEach((fn) =>
    fn({ ...user("a"), access_token: "rotated" } as User),
  );
  expect(s.activate).toHaveBeenCalledOnce();
  expect(s.handlers.onRefresh).toHaveBeenCalledOnce();
  expect(s.cache.getQueryData(["sessions", 0])).toEqual({ items: ["private"] });
  s.events.loaded.forEach((fn) =>
    fn({
      ...user("a"),
      profile: { ...user("a").profile, iss: "https://other.example" },
    } as User),
  );
  expect(s.activate).toHaveBeenCalledTimes(2);
  s.events.unloaded.forEach((fn) => fn());
  s.events.loaded.forEach((fn) => fn(user("a")));
  expect(s.activate).toHaveBeenCalledTimes(3);
  s.dispose();
});
it("does not treat missing identity claims as a same-user refresh", async () => {
  const s = setup();
  s.resolve({ access_token: "one", expired: false } as User);
  await Promise.resolve();
  s.events.loaded.forEach((fn) =>
    fn({ access_token: "two", expired: false } as User),
  );
  expect(s.activate).toHaveBeenCalledTimes(2);
  expect(s.handlers.onRefresh).not.toHaveBeenCalled();
  s.dispose();
});
