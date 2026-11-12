import { expect, it, vi } from "vitest";
const signoutRedirect = vi.hoisted(() => vi.fn(async () => {}));
const removeUser = vi.hoisted(() => vi.fn());
vi.mock("oidc-client-ts", () => ({
  UserManager: class {
    signoutRedirect = signoutRedirect;
    removeUser = removeUser;
  },
  InMemoryWebStorage: class {},
  WebStorageStateStore: class {},
}));
it("delegates OIDC logout without removing the ID token first", async () => {
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://identity.example");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "web");
  vi.stubGlobal("location", { origin: "https://app.example" });
  vi.stubGlobal("sessionStorage", {});
  vi.resetModules();
  const { logout } = await import("./auth");
  await logout();
  expect(signoutRedirect).toHaveBeenCalledOnce();
  expect(removeUser).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("keeps a local token only until logout and permits login again", async () => {
  vi.resetModules();
  const { token, setLocalToken, logout } = await import("./auth");
  setLocalToken("first");
  expect(await token()).toBe("first");
  await logout();
  expect(await token()).toBeUndefined();
  setLocalToken("second");
  expect(await token()).toBe("second");
  await logout();
});
