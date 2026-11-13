import type { User, UserManager } from "oidc-client-ts";
// OIDC events and async restoration share one boundary, including late results.
export function observeOidcSession(
  manager: Pick<
    UserManager,
    "events" | "getUser" | "signinRedirectCallback" | "settings"
  >,
  callback: boolean,
  handlers: {
    onUser: (user: User) => void;
    onRefresh: (user: User) => void;
    onEnd: () => void;
    onError: (error: unknown) => void;
    onCallback: (user: User) => void;
  },
) {
  let disposed = false,
    version = 0,
    activeToken: string | undefined,
    activeIdentity: string | undefined;
  const end = () => {
    if (disposed) return;
    version++;
    activeToken = undefined;
    activeIdentity = undefined;
    handlers.onEnd();
  };
  const loaded = (user: User) => {
    if (disposed) return;
    if (user.expired) {
      end();
      return;
    }
    version++;
    activeToken = user.access_token;
    const issuer = user.profile?.iss || manager.settings?.authority;
    const subject = user.profile?.sub;
    // Missing identity claims cannot establish that it is the same user.
    const identity =
      issuer && subject ? JSON.stringify([issuer, subject]) : undefined;
    const sameIdentity = identity !== undefined && identity === activeIdentity;
    activeIdentity = identity;
    if (sameIdentity) handlers.onRefresh(user);
    else handlers.onUser(user);
  };
  manager.events.addUserLoaded(loaded);
  manager.events.addUserUnloaded(end);
  manager.events.addAccessTokenExpired(end);
  const initialVersion = version;
  void (callback ? manager.signinRedirectCallback() : manager.getUser())
    .then((user) => {
      if (disposed) return;
      if (version === initialVersion) {
        if (user && !user.expired) loaded(user);
        else end();
      }
      if (callback && user && activeToken === user.access_token)
        handlers.onCallback(user);
    })
    .catch((error) => {
      if (disposed || version !== initialVersion) return;
      end();
      handlers.onError(error);
    });
  return () => {
    disposed = true;
    manager.events.removeUserLoaded(loaded);
    manager.events.removeUserUnloaded(end);
    manager.events.removeAccessTokenExpired(end);
  };
}
