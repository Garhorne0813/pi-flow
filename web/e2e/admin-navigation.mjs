import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const admin of [false, true]) {
    const page = await browser.newPage();
    let adminCalls = 0;
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ json: body });
      if (path.endsWith("/me")) return json({ userId: "user", admin });
      if (path.includes("/admin/")) adminCalls++;
      if (path.endsWith("/admin/config/agents"))
        return json({ revision: 0, items: [] });
      if (path.endsWith("/agents")) return json({ items: [] });
      if (path.endsWith("/configuration"))
        return json({
          agentDefaults: {},
          skillUploads: {
            enabled: false,
            maxArchiveBytes: 1000,
            maxExpandedBytes: 1000,
            maxFiles: 10,
          },
          defaultsRevision: 0,
          deployment: { bundles: [], endpoints: [], models: [] },
        });
      if (path.endsWith("/config/global"))
        return json({
          revision: 0,
          modelCatalog: [],
          policy: { disabledTools: [] },
        });
      return json({ items: [] });
    });
    await page.goto("http://localhost:5173/chat");
    await page.getByRole("link", { name: "个人设置", exact: true }).waitFor();
    await page.waitForFunction(
      (admin) =>
        document.querySelector(".profile-copy small")?.textContent ===
        (admin ? "管理员" : "普通用户"),
      admin,
    );
    assert.equal(
      await page.getByRole("link", { name: "管理中心", exact: true }).count(),
      admin ? 1 : 0,
    );
    for (const name of [
      "Agent 管理",
      "Skills 管理",
      "MCP Servers",
      "子 Agent 委派",
      "全局配置",
    ])
      assert.equal(
        await page.getByRole("link", { name, exact: true }).count(),
        0,
      );
    if (admin) {
      await page.getByRole("link", { name: "管理中心", exact: true }).click();
      await page.waitForURL("**/admin/agents");
      for (const [path, name] of [
        ["agents", "Agent 管理"],
        ["skills", "Skills 管理"],
        ["mcp", "MCP Servers"],
        ["delegation", "子 Agent 委派"],
        ["settings", "全局配置"],
      ]) {
        const link = page.getByRole("link", { name, exact: true });
        assert.equal(await link.count(), 1);
        await link.click();
        await page.waitForURL("**/admin/" + path);
        assert.equal(await link.getAttribute("aria-current"), "page");
        assert.equal(
          await page.getByRole("navigation", { name: "管理功能" }).count(),
          1,
        );
        assert.equal(
          await page
            .getByRole("button", { name: "新建对话", exact: true })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("link", { name: "个人设置", exact: true })
            .count(),
          0,
        );
        await page.reload(); // Every existing deep link survives reload.
        await page.getByRole("link", { name, exact: true }).waitFor();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "展开管理导航" }).click();
      await page.getByRole("link", { name: "Agent 管理", exact: true }).click();
      await page.waitForURL("**/admin/agents");
      assert.equal(await page.locator("aside.visible").count(), 0);
      await page.getByRole("button", { name: "展开管理导航" }).click();
      await page.getByRole("link", { name: "返回聊天", exact: true }).click();
      await page.waitForURL("**/chat");
      await page.getByRole("button", { name: "展开会话列表" }).click();
      await page.getByRole("link", { name: "管理中心", exact: true }).waitFor();
    } else {
      for (const path of [
        "",
        "/agents",
        "/skills",
        "/mcp",
        "/delegation",
        "/settings",
      ]) {
        await page.goto("http://localhost:5173/admin" + path);
        await page
          .getByRole("heading", { name: "无权访问", exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("link", { name: "Agent 管理", exact: true })
            .count(),
          0,
        );
      }
      assert.equal(adminCalls, 0);
    }
    await page.close();
  }
  console.log(
    "PASS: single admin entry, dedicated navigation, active links, deep links, mobile drawer, return to chat, non-admin denial",
  );
} finally {
  await browser.close();
}
