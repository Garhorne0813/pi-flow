import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  let revision = 0,
    defaultsRevision = 0,
    failGlobal = false,
    failDefaults = false;
  const defaults = {
    model: { provider: "demo", modelId: "demo" },
    skillBundle: "default",
    tools: ["read"],
    maxSteps: 30,
    maxTokens: 1000,
    timeoutSeconds: 60,
    maxSubagents: 1,
    maxDepth: 1,
  };
  const posts = [];
  await page.route("**/api/v1/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    const method = r.request().method();
    const json = (body) => r.fulfill({ json: body });
    const failed = () =>
      r.fulfill({ status: 503, json: { error: { code: "READ_UNAVAILABLE" } } });
    if (path.endsWith("/me")) return json({ userId: "admin", admin: true });
    if (path.endsWith("/config/global")) {
      if (method === "POST") {
        const b = r.request().postDataJSON();
        assert.equal(b.revision, revision);
        posts.push(b);
        revision++;
        failGlobal = true;
        return json({
          revision,
          modelCatalog: b.modelCatalog,
          policy: b.policy,
        });
      }
      return failGlobal
        ? failed()
        : json({ revision, modelCatalog: [], policy: { disabledTools: [] } });
    }
    if (path.endsWith("/configuration/defaults")) {
      const b = r.request().postDataJSON();
      assert.equal(b.expectedRevision, defaultsRevision);
      posts.push(b);
      defaultsRevision++;
      failDefaults = true;
      const { expectedRevision, ...agentDefaults } = b;
      return json({ agentDefaults, defaultsRevision });
    }
    if (path.endsWith("/configuration"))
      return failDefaults
        ? failed()
        : json({ agentDefaults: defaults, defaultsRevision, deployment: {} });
    return json({ items: [] });
  });
  await page.goto("http://localhost:5173/admin/settings");
  await page.getByLabel("全局禁用工具（逗号分隔）").fill("bash");
  await page.getByRole("button", { name: "保存全局配置", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "全局配置已保存；重新读取失败" })
    .waitFor();
  assert.match(
    await page.getByText("当前配置版本：", { exact: false }).textContent(),
    /版本：1/,
  );
  await page.getByRole("button", { name: "保存全局配置", exact: true }).click();
  await page.getByText("当前配置版本：2。", { exact: false }).waitFor();
  await page.getByLabel("最大执行步数").fill("42");
  await page
    .getByRole("button", { name: "保存 Agent 默认配置", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Agent 默认配置已保存；重新读取失败" })
    .waitFor();
  await page
    .getByRole("button", { name: "保存 Agent 默认配置", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.body.textContent.includes("版本：2"),
  );
  assert.equal(posts[3].expectedRevision, 1);
  console.log(
    "PASS: successful writes survive failed reads, report saved status, and next writes use returned revisions",
  );
} finally {
  await browser.close();
}
