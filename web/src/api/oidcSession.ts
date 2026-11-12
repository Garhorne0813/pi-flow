import type { User, UserManager } from "oidc-client-ts";
// OIDC events and async restoration share one boundary, including late results.
export function observeOidcSession(
  manager: Pick<UserManager, "events" | "getUser" | "signinRedirectCallback">,
  callback: boolean,
  handlers: {
    onUser: (user: User) => void;
    onEnd: () => void;
    onError: (error: unknown) => void;
    onCallback: (user: User) => void;
  },
) {
  let disposed = false,
    version = 0,
    activeToken: string | undefined;
  const end = () => {
    if (disposed) return;
    version++;
    activeToken = undefined;
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
    handlers.onUser(user);
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
