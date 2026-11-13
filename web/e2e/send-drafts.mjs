import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  let heldA, heldCreate;
  let bRuns = 0;
  await page.route("**/api/v1/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    const method = r.request().method();
    const json = (body) => r.fulfill({ json: body });
    if (path.endsWith("/me")) return json({ userId: "user", admin: false });
    if (path.endsWith("/agents"))
      return json({ items: [{ id: "one", config: { name: "One" } }] });
    if (path.endsWith("/sessions") && method === "POST") {
      heldCreate = r;
      return;
    }
    if (path.endsWith("/sessions"))
      return json({
        items: ["A", "B"].map((id) => ({
          id,
          title: "Chat " + id,
          agentId: "one",
        })),
      });
    if (path.endsWith("/timeline"))
      return json({ items: [], nextCursor: null });
    if (path.endsWith("/active-task")) return json({ activeRun: null });
    if (path.endsWith("/A/runs")) {
      heldA = r;
      return;
    }
    if (path.endsWith("/B/runs")) {
      bRuns++;
      return json({ id: "run-B", state: "QUEUED" });
    }
    if (path.endsWith("/C/runs")) {
      assert.equal(r.request().postDataJSON().message, "first message");
      return json({ id: "run-C", state: "QUEUED" });
    }
    return json({ items: [] });
  });
  const input = page.getByLabel("发送消息", { exact: true });
  await page.goto("http://localhost:5173/chat/A");
  await input.fill("message A");
  await page.getByLabel("发送 ↑", { exact: true }).click();
  await input.fill("next draft A");
  await heldA.fulfill({ json: { id: "run-A", state: "QUEUED" } });
  await page.getByLabel("发送 ↑", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector("textarea").value === "next draft A",
  );
  assert.equal(await input.inputValue(), "next draft A");
  // Keep A sending while switching to B; B's independent send must reach the API.
  heldA = undefined;
  await page.getByLabel("发送 ↑", { exact: true }).click();
  await page.getByRole("link", { name: "Chat B", exact: true }).click();
  await input.fill("message B");
  await page.getByLabel("发送 ↑", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("textarea").value === "",
  );
  assert.equal(bRuns, 1);
  await input.fill("next draft B");
  await heldA.fulfill({ json: { id: "run-A2", state: "QUEUED" } });
  await page.waitForTimeout(100);
  assert.equal(await input.inputValue(), "next draft B");
  // Editing during session creation transfers the latest draft, while sending the captured message.
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await input.fill("first message");
  await page.getByLabel("开始对话 →", { exact: true }).click();
  await input.fill("new-session followup");
  await heldCreate.fulfill({ json: { id: "C", agentId: "one" } });
  await page.waitForURL("**/chat/C");
  await page.waitForFunction(
    () => document.querySelector("textarea").value === "new-session followup",
  );
  assert.equal(await input.inputValue(), "new-session followup");
  console.log(
    "PASS: delayed sends preserve newer drafts, A does not block B, and session creation transfers the latest draft",
  );
} finally {
  await browser.close();
}
