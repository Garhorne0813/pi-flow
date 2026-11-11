import { existsSync } from "node:fs";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.CHAT_WEB_URL || "http://127.0.0.1:5173/chat");
  await page
    .getByLabel("选择 Agent")
    .locator("option")
    .first()
    .waitFor({ state: "attached" });
  await page.getByLabel("发送消息").fill("Hello Pi-Flow browser");
  await page.getByRole("button", { name: "开始对话 →" }).click();
  await page.waitForURL(/\/chat\/[0-9a-f-]+$/);
  await page
    .getByText("Demo harness response: Hello Pi-Flow browser", { exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".message.user").count(), 1);
  assert.equal(await page.locator(".message.assistant").count(), 1);
  await page.reload();
  await page
    .getByText("Demo harness response: Hello Pi-Flow browser", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".message.user").count(), 1);
  assert.equal(await page.locator(".message.assistant").count(), 1);
  await page.getByLabel("发送消息").fill("Second turn");
  await page.getByRole("button", { name: "发送 ↑" }).click();
  await page
    .getByText("Demo harness response: Second turn", { exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".message.assistant").count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/pi-flow-chat-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: create, send, SSE, refresh history, second turn, mobile, no page errors",
  );
} finally {
  await browser.close();
}
