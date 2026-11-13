import {
  UserManager,
  User,
  InMemoryWebStorage,
  WebStorageStateStore,
} from "oidc-client-ts";
const manager = new UserManager({
  authority: "https://id.example",
  client_id: "test",
  redirect_uri: location.origin + "/callback",
  userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  automaticSilentRenew: false,
});
const output = document.getElementById("state")!;
async function show() {
  output.textContent = (await manager.getUser()) ? "signed in" : "signed out";
}
document.getElementById("store")!.onclick = async () => {
  await manager.storeUser(
    new User({
      access_token: "storage-test-token",
      token_type: "Bearer",
      profile: {
        iss: "https://id.example",
        sub: "test",
        aud: "test",
        exp: 9999999999,
        iat: 1,
      },
    }),
  );
  await show();
};
void show();
