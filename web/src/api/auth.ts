import {
  InMemoryWebStorage,
  UserManager,
  WebStorageStateStore,
} from "oidc-client-ts";
const authority = import.meta.env.VITE_OIDC_AUTHORITY,
  client = import.meta.env.VITE_OIDC_CLIENT_ID;
export const auth =
  authority && client
    ? new UserManager({
        authority,
        client_id: client,
        response_type: "code",
        scope: import.meta.env.VITE_OIDC_SCOPE || "openid profile",
        redirect_uri: location.origin + "/auth/callback",
        post_logout_redirect_uri: location.origin + "/chat",
        userStore: new WebStorageStateStore({
          store: new InMemoryWebStorage(),
        }),
        stateStore: new WebStorageStateStore({ store: sessionStorage }),
        automaticSilentRenew: false,
      })
    : null;
export async function token() {
  return (await auth?.getUser())?.access_token;
}
export async function login() {
  await auth?.signinRedirect({ state: { returnTo: location.pathname } });
}
export async function logout() {
  await auth?.removeUser();
  if (auth) await auth.signoutRedirect();
}
