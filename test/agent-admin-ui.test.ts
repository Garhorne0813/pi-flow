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
    constructor(readonly tagName = "div") {}
    checked = false;
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
    querySelectorAll(selector: string): Element[] {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
      return descendants.filter(child => selector.split(",").some(part => {
        const query = part.trim();
        if (query === "*") return true;
        const tag = query.match(/^[a-z]+/)?.[0];
        if (tag && child.tagName !== tag) return false;
        if (query.endsWith(":checked") && !child.checked) return false;
        const attribute = query.match(/\[data-([a-z-]+)(?:="([^"]*)")?\]/);
        if (attribute) {
          const key = attribute[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
          if (!(key in child.dataset) || (attribute[2] !== undefined && child.dataset[key] !== attribute[2])) return false;
        }
        return true;
      }));
    }
    setAttribute() {}
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
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: (selector: string) => [...elements.values()].flatMap(root => root.querySelectorAll(selector)) },
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


test("clone/publish preserves Markdown entry boundaries, whitespace and empty entries", async () => {
  for (const agentsMd of [
    ["# Rules\n- Use TypeScript\n- Keep formatting", "  ```ts\n  const value = 1;\n  ```\n\n"],
    [],
    ["", "\n", "  indentation matters  "],
  ]) {
    const config = {
      name:"Original",systemPrompt:"Test",agentsMd,model:{provider:"demo",modelId:"demo"},
      tools:["read"],skills:[],mcpServers:[],subagents:[],skillBundle:"default",
      maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1,
    };
    const original = {id:"original",config,enabled:true,publishedAt:new Date().toISOString(),digest:"test"};
    let published: typeof config | undefined;
    const get = consoleController(async (url,options) => {
      if (options?.method === "POST") {
        published = JSON.parse(options.body as string);
        return Response.json({...original,id:"clone",config:published});
      }
      return Response.json({items:String(url).includes("/admin/agents?") ? [original] : []});
    });
    get("token").value = "test-admin-token";
    await get("connect").dispatch();
    await get("list").children[0]!.dispatch();
    assert.deepEqual(get("agents-md").querySelectorAll("textarea").map(input=>input.value),agentsMd);
    assert.ok(get("agents-md").querySelectorAll("textarea").every(input=>input.disabled));
    assert.equal(get("add-agents-md").disabled,true);
    await get("clone").dispatch();
    assert.ok(get("agents-md").querySelectorAll("textarea").every(input=>!input.disabled));
    await get("form").dispatch("submit");
    assert.deepEqual(published?.agentsMd,agentsMd);
  }
});

test("defaults edits survive refresh and unrelated mutations, then reset on save/reconnect", async () => {
  let saved = {
    model:{provider:"demo",modelId:"demo"},tools:["read"],skillBundle:"default",
    maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1,
  };
  let failSave = true;
  const skill = {id:"review@v1",name:"Review",description:"",bundle:"default",path:"/skills/review/SKILL.md",digest:"a".repeat(64),enabled:true};
  const get = consoleController(async (url,options) => {
    if (String(url).endsWith("/configuration/defaults")) {
      if (failSave) return Response.json({error:{code:"INVALID_REQUEST"}},{status:400});
      saved = JSON.parse(options!.body as string);return Response.json(saved);
    }
    if (options?.method === "PUT") {skill.enabled = !skill.enabled;return Response.json(skill);}
    if (String(url).endsWith("/configuration")) return Response.json({agentDefaults:saved,deployment:{bundles:["default","other"],models:[],endpoints:[]}});
    return Response.json({items:String(url).includes("/skills?") ? [skill] : []});
  });
  get("token").value = "test-admin-token";await get("connect").dispatch();
  const edits = {"default-provider":"  enterprise  ","default-model":"coding","default-bundle":"other","default-steps":"51","default-tokens":"123456","default-timeout":"321","default-subagents":"4","default-depth":"3"};
  for (const [id,value] of Object.entries(edits)) get(id).value = value;
  const tools = get("default-tools").querySelectorAll("input");
  for (const input of tools) input.checked = input.value === "bash";
  const assertDraft = () => {
    for (const [id,value] of Object.entries(edits)) assert.equal(get(id).value,value,id);
    assert.deepEqual(get("default-tools").querySelectorAll("input:checked").map(input=>input.value),["bash"]);
  };
  await get("refresh-console").dispatch();assertDraft();
  await get("skill-registry").querySelectorAll("button")[0]!.dispatch();assertDraft();
  await get("defaults-form").dispatch("submit");assertDraft();assert.match(get("message").textContent,/操作失败/);
  failSave = false;await get("defaults-form").dispatch("submit");
  assert.equal(get("default-provider").value,"enterprise");assert.equal(saved.maxSteps,51);
  assert.deepEqual(saved.tools,["bash"]);assert.equal(saved.skillBundle,"other");
  get("default-steps").value = "99";
  await get("disconnect").dispatch();
  get("token").value = "test-admin-token";await get("connect").dispatch();
  assert.equal(get("default-steps").value,"51");
});
