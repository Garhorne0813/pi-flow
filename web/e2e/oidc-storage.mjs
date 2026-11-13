import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.route("**/oidc-storage", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<button id="store">store</button><output id="state"></output><script type="module" src="/e2e/oidc-storage.ts"></script>',
    }),
  );
  await page.goto("http://localhost:5173/oidc-storage");
  await page.getByText("signed out", { exact: true }).waitFor();
  await page.getByRole("button", { name: "store", exact: true }).click();
  await page.getByText("signed in", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage),
      ]).includes("storage-test-token"),
    ),
    false,
  );
  await page.reload();
  await page.getByText("signed out", { exact: true }).waitFor();
  console.log(
    "PASS: real oidc-client-ts memory store clears on full browser refresh and does not persist token",
  );
} finally {
  await browser.close();
}
