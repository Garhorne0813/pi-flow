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
    assert.match(page.body, /Pi-Flow 管理控制台/);

    const data = await app.inject({ method: "GET", url: "/api/v1/admin/agents" });
    assert.equal(data.statusCode, 401);
    assert.equal(data.json().error.code, "UNAUTHENTICATED");
  } finally {
    await app.close();
  }
});

/** Small DOM adapter to execute the actual embedded controller without a browser dependency. */
function consoleController(fetch: typeof globalThis.fetch) {
  class Element {
    value = "";
    textContent = "";
    className = "";
    disabled = false;
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    children: Element[] = [];
    listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    querySelectorAll() { return []; }
    addEventListener(name: string, callback: (event: { preventDefault(): void }) => unknown) {
      this.listeners.set(name, callback);
    }
    async dispatch(name = "click") {
      await this.listeners.get(name)?.({ preventDefault() {} });
    }
  }
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const script = agentAdminHTML.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!;
  new Script(script).runInNewContext({
    document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [] },
    fetch, AbortController, DOMException, structuredClone,
    window: { confirm: () => true },
  });
  return get;
}

test("disconnect aborts requests and late responses cannot restore the old connection", async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  const get = consoleController(async (_url, options) => new Promise<Response>((resolve) => {
    pending.push({ resolve, signal: options!.signal! });
  }));
  get("token").value = "test-admin-token";
  const connecting = get("connect").dispatch();
  assert.equal(pending.length, 4);
  assert.equal(get("disconnect").disabled, false);
  await get("disconnect").dispatch();
  for (const request of pending) {
    assert.equal(request.signal.aborted, true);
    request.resolve(Response.json({ items: [] }));
  }
  await connecting;
  assert.equal(get("connection").textContent, "未连接");
  assert.equal(get("count").textContent, "0");
  assert.match(get("message").textContent, /已断开/);
  assert.equal(get("publish").disabled, true);
});

test("successful publish stays read-only when refresh fails and cannot be submitted twice", async () => {
  let publications = 0;
  const get = consoleController(async (url, options) => {
    if (options?.method === "POST") {
      publications++;
      return Response.json({
        id: "new-version", config: JSON.parse(options.body as string),
        enabled: true, publishedAt: new Date().toISOString(), digest: "test",
      });
    }
    if (publications && String(url).includes("/skills"))
      return Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 });
    return Response.json({ items: [] });
  });
  get("token").value = "test-admin-token";
  await get("connect").dispatch();
  get("name").value = "Regression agent";
  get("prompt").value = "Test prompt";
  get("provider").value = "demo";
  get("model").value = "demo";
  await get("form").dispatch("submit");
  assert.match(get("message").textContent, /发布成功/);
  assert.match(get("message").textContent, /列表刷新失败/);
  assert.equal(get("version-id").textContent, "new-version");
  assert.equal(get("publish").disabled, true);
  await get("form").dispatch("submit");
  assert.equal(publications, 1);
});
