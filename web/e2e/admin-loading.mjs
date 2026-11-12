import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const module of ["agents", "skills", "mcp", "delegation"]) {
    const page = await browser.newPage();
    const reads = [];
    let recovered = false;
    const allowed =
      module === "agents"
        ? ["/admin/config/agents", "/admin/configuration"]
        : module === "skills"
          ? ["/admin/skills", "/admin/configuration"]
          : module === "mcp"
            ? ["/admin/mcp-servers", "/admin/configuration"]
            : ["/admin/config/agents"];
    await page.route("**/api/v1/**", (route) => {
      const path = new URL(route.request().url()).pathname.replace(
        "/api/v1",
        "",
      );
      const json = (body) => route.fulfill({ json: body });
      if (path === "/me") return json({ userId: "admin", admin: true });
      if (!path.startsWith("/admin/")) return json({ items: [] });
      reads.push(path);
      if (!allowed.includes(path) && !recovered)
        return route.fulfill({
          status: 500,
          json: { error: { code: "UNRELATED_FAILURE" } },
        });
      if (path === "/admin/config/agents")
        return json({ revision: 0, items: [] });
      if (path === "/admin/configuration")
        return json({
          agentDefaults: {},
          deployment: { models: [], bundles: [], endpoints: [] },
          skillUploads: {
            enabled: false,
            maxArchiveBytes: 100,
            maxExpandedBytes: 100,
            maxFiles: 1,
          },
        });
      return json({ items: [] });
    });
    await page.goto("http://localhost:5173/admin/" + module);
    if (module === "agents") {
      await page
        .getByRole("button", { name: "新建 Agent", exact: true })
        .click();
      await page
        .getByLabel("System Prompt", { exact: true })
        .fill("editable despite failed registries");
      await page
        .getByText("部分绑定列表加载失败，其他配置仍可编辑。", { exact: false })
        .waitFor();
      assert.equal(
        await page
          .getByRole("group", { name: "绑定 Skills", exact: true })
          .evaluate((el) => el.disabled),
        true,
      );
      assert.equal(
        await page
          .getByRole("group", { name: "绑定 MCP Servers", exact: true })
          .evaluate((el) => el.disabled),
        true,
      );
      recovered = true;
      await page
        .getByRole("button", { name: "重试绑定列表", exact: true })
        .click();
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("fieldset"))
          .filter((el) =>
            ["绑定 Skills", "绑定 MCP Servers"].includes(
              el.querySelector("legend")?.textContent,
            ),
          )
          .every((el) => !el.disabled),
      );
      assert.equal(
        await page.getByLabel("System Prompt", { exact: true }).inputValue(),
        "editable despite failed registries",
      );
    } else if (module === "delegation")
      await page
        .getByRole("heading", { name: "委派关系", exact: true })
        .waitFor();
    else
      await page
        .getByRole("heading", {
          name: module === "skills" ? "Skills" : "MCP Servers",
          exact: true,
        })
        .waitFor();
    if (module !== "agents")
      assert.deepEqual([...new Set(reads)].sort(), allowed.sort());
    assert.equal(
      await page.getByText("UNRELATED_FAILURE", { exact: true }).count(),
      0,
    );
    await page.close();
  }
  console.log(
    "PASS: module-specific dependencies; Agent editing remains available when Skills/MCP fail, unavailable bindings disabled",
  );
} finally {
  await browser.close();
}
