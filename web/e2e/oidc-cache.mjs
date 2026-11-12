import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.route("**/src/api/auth.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
 let current='A'; const loaded=new Set(),unloaded=new Set(),expired=new Set();
 const user=()=>({access_token:current,expired:false});
 export const auth={getUser:async()=>user(),signinRedirectCallback:async()=>user(),events:{
 addUserLoaded:f=>loaded.add(f),removeUserLoaded:f=>loaded.delete(f),
 addUserUnloaded:f=>unloaded.add(f),removeUserUnloaded:f=>unloaded.delete(f),
 addAccessTokenExpired:f=>expired.add(f),removeAccessTokenExpired:f=>expired.delete(f)}};
 export const token=async()=>current; export const login=async()=>{};
 export const logout=async()=>{unloaded.forEach(f=>f());}; export const setLocalToken=()=>{};
 window.oidcTest={change:name=>{current=name;loaded.forEach(f=>f(user()));},expire:()=>expired.forEach(f=>f())};
 `,
    }),
  );
  let heldB;
  let bSessionRequests = 0;
  await page.route("**/api/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const who = route.request().headers().authorization?.slice(7);
    const json = (body) => route.fulfill({ json: body });
    if (path.endsWith("/me")) {
      if (who === "B") {
        heldB = () => json({ userId: who, admin: false });
        return;
      }
      if (who === "revoked")
        return route.fulfill({
          status: 401,
          json: { error: { code: "UNAUTHENTICATED" } },
        });
      return json({ userId: who, admin: true });
    }
    if (path.endsWith("/agents")) return json({ items: [] });
    if (path.endsWith("/sessions")) {
      if (who === "B") bSessionRequests++;
      return json({
        items: [{ id: who, title: who + " private conversation" }],
      });
    }
    return json({ items: [] });
  });
  await page.goto("http://localhost:5173/chat");
  await page
    .getByRole("link", { name: "A private conversation", exact: true })
    .waitFor();
  await page.evaluate(() => window.oidcTest.change("B"));
  await page.waitForFunction(
    () => !document.body.textContent.includes("A private conversation"),
  );
  assert.equal(bSessionRequests, 0);
  // Wait until B's identity request arrives, then finish identity verification.
  for (let n = 0; !heldB && n < 100; n++) await page.waitForTimeout(20);
  assert.ok(heldB);
  await heldB();
  await page
    .getByRole("link", { name: "B private conversation", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("link", { name: "管理中心", exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.oidcTest.expire());
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  assert.equal(
    await page.getByText("B private conversation", { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.oidcTest.change("C"));
  await page
    .getByRole("link", { name: "C private conversation", exact: true })
    .waitFor();
  await page.getByLabel("退出登录", { exact: true }).click();
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  await page.evaluate(() => window.oidcTest.change("revoked"));
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "C private conversation", exact: true })
      .count(),
    0,
  );
  console.log(
    "PASS: mocked OIDC restoration, A-to-B switch before identity response, expiry, re-login, logout and identity 401",
  );
} finally {
  await browser.close();
}
