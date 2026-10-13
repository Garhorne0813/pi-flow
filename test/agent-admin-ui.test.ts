import assert from "node:assert/strict";
import { Script } from "node:vm";
import { test } from "node:test";
import { buildAPI } from "../src/api.js";
import { agentAdminHTML } from "../src/agent-admin-ui.js";
import { Fault } from "../src/domain.js";
import type { Auth } from "../src/auth.js";
import type { HarnessService } from "../src/service.js";
import type { SandboxManager } from "../src/adapters/sandbox.js";

test("Agent console includes editable configuration and valid browser script", () => {
  for (const id of [
    "token", "list", "form", "name", "prompt", "provider", "model",
    "tools", "skills", "mcps", "subagents", "publish", "clone",
    "allowed-users", "save-access", "toggle",
  ])
    assert.match(agentAdminHTML, new RegExp('id="' + id + '"'));

  const script = agentAdminHTML.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "inline controller must exist");
  assert.doesNotThrow(() => new Script(script));
  assert.match(script, /Authorization: "Bearer "/);
  assert.doesNotMatch(script, /\b(?:localStorage|sessionStorage)\b/);
  assert.doesNotMatch(agentAdminHTML, /<script\s+src=/);
});

test("unauthenticated access serves only the public UI shell, not admin APIs", async () => {
  const reject: Auth = async () => { throw new Fault(401, "UNAUTHENTICATED"); };
  const app = buildAPI({} as HarnessService, reject, {} as SandboxManager);
  try {
    const page = await app.inject({ method: "GET", url: "/admin/agents/ui" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] as string, /text\/html/);
    assert.match(page.headers["cache-control"] as string, /no-store/);
    const csp = page.headers["content-security-policy"] as string;
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src 'unsafe-inline'/);
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, "each response must specify a script nonce");
    assert.ok(page.body.includes('<script nonce="' + nonce + '">'));
    assert.match(page.body, /Agent 配置中心/);

    const data = await app.inject({ method: "GET", url: "/api/v1/admin/agents" });
    assert.equal(data.statusCode, 401);
    assert.equal(data.json().error.code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
});
