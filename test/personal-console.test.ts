import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium as browserEngine } from "playwright-core";
import { buildAPI } from "../src/api/server.js";
import { MemoryStore } from "../src/storage/store.js";
import { MemoryRegistry, principal } from "../src/storage/registry.js";
import { personalStore } from "../src/storage/personal.js";
import { PersonalService } from "../src/domain/personal-service.js";
import { seedDemo } from "../src/config/agents.js";
import { DemoSandbox, SandboxManager } from "../src/sandbox/manager.js";
import { HostSkillPackages } from "../src/skills/packages.js";
import { skillZip, skillMarkdown } from "./helpers/skill-zip.js";

const chromium = [
  process.env.CHROMIUM_PATH,
  "/usr/bin/chromium",
  browserEngine.executablePath(),
].find((p): p is string => !!p && existsSync(p));
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !chromium)
  throw new Error("Chromium required for personal console acceptance");

async function setup(packages?: HostSkillPackages) {
  const registry = new MemoryRegistry();
  await registry.tx(seedDemo);
  const store = personalStore(new MemoryStore(), registry);
  const service = new PersonalService(store, registry, ["gateway"]);
  const authenticated = {
    tenantId: "identity-provider",
    userId: "admin",
    admin: true,
  };
  const actor = await principal(registry, authenticated);
  const app = buildAPI(
    service,
    async (header) => ({
      ...authenticated,
      userId: header === "other" ? "other-admin" : "admin",
    }),
    new SandboxManager(store, new DemoSandbox()),
    undefined,
    packages,
  );
  return { app, registry, service, store, actor };
}

test("personal console management writes platform registry shared across principals and invalidates stale edits", async () => {
  const { app, registry } = await setup();
  try {
    const config = (
      await app.inject({ url: "/api/v1/admin/configuration" })
    ).json();
    assert.equal(config.agentMode, "editable");
    const listed = await app.inject({ url: "/api/v1/admin/agents" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].id, "assistant");
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/agents/assistant/status",
      payload: { enabled: false },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(
      await registry.read((s) => s.managedAgents!.assistant!.enabled),
      false,
    );
    const other = (
      await app.inject({
        url: "/api/v1/admin/agents",
        headers: { authorization: "other" },
      })
    ).json();
    assert.equal(other.items[0].enabled, false);
    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/admin/config/agents",
      payload: { revision: config.agentsRevision, agents: [] },
    });
    assert.equal(stale.statusCode, 409);
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/admin/mcp-servers",
      payload: { id: "docs", endpointRef: "gateway", allowedTools: ["search"] },
    });
    assert.equal(registered.statusCode, 201);
    assert.equal(await registry.read((s) => s.mcp.docs!.enabled), true);
    const acl = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/logical-agents/assistant/access",
      payload: { allowedUsers: ["allowed-user"] },
    });
    assert.equal(acl.statusCode, 200);
    assert.deepEqual(
      await registry.read((s) => s.managedAgents!.assistant!.allowedUsers),
      ["allowed-user"],
    );
  } finally {
    await app.close();
  }
});

test(
  "personal browser console edits stable configurations without losing snapshots or extra fields and uploads Skills",
  { skip: !chromium },
  async () => {
    const root = await mkdtemp(resolve("work/personal-console-"));
    const { app, registry, service, actor, store } = await setup(
      new HostSkillPackages(root),
    );
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = true;
    });
    const session = await service.createPersonalSession(actor, {
      agentId: "assistant",
    });
    // Queue a snapshot without caller token access, then restore the editable field.
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = false;
    });
    const queued = await service.submit(
      actor,
      session.id,
      "queued before edit",
    );
    await registry.tx((s) => {
      s.managedAgents!.assistant!.config.userTokenAccess = true;
    });
    const browser = await browserEngine.launch({
      executablePath: chromium,
      args: ["--no-sandbox"],
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const page = await browser.newPage();
      page.on("dialog", (d) => d.accept());
      await page.goto(address + "/admin/ui");
      await page.locator("#token").fill("admin");
      await page.locator("#connect").click();
      await page.locator("#connection").filter({ hasText: "已连接" }).waitFor();
      await page.locator(".agent-item").click();
      await page.locator("#clone").click();
      await page.locator("#prompt").fill("Edited from personal console");
      await page.locator("#publish").click();
      await page.locator("#confirm-publish").click();
      await page
        .locator("#message")
        .filter({ hasText: "配置已保存" })
        .waitFor();
      assert.equal(await page.locator(".agent-item").count(), 1);
      const current = await registry.read((s) => s.managedAgents!.assistant!);
      assert.equal(current.config.systemPrompt, "Edited from personal console");
      assert.equal(current.config.userTokenAccess, true);
      assert.equal(await registry.read((s) => Object.keys(s.agents).length), 0);
      assert.equal(
        await store.readRun(
          actor.tenantId,
          queued.id,
          (s) => s.runs[queued.id]!.capabilities!.systemPrompt,
        ),
        queued.capabilities!.systemPrompt,
      );
      await page.locator("#tab-skills").click();
      await page.locator("#upload-skill-id").fill("personal-review@v1");
      await page.locator("#upload-skill-name").fill("Personal review");
      await page.locator("#skill-zip").setInputFiles({
        name: "skill.zip",
        mimeType: "application/zip",
        buffer: skillZip([{ path: "SKILL.md", content: skillMarkdown }]),
      });
      await page.locator("#upload-skill").click();
      await page
        .locator("#skill-registry")
        .filter({ hasText: "personal-review@v1" })
        .waitFor();
      assert.equal(
        await registry.read((s) => s.skills["personal-review@v1"]?.enabled),
        true,
      );
    } finally {
      await browser.close();
      await app.close();
      async function unseal(dir: string) {
        await chmod(dir, 0o755);
        for (const entry of await readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory()) await unseal(dir + "/" + entry.name);
      }
      await unseal(root);
      await rm(root, { recursive: true, force: true });
    }
  },
);
