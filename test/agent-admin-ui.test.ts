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
function consoleController(fetch: typeof globalThis.fetch, confirm = () => true) {
  class Element {
    constructor(readonly tagName = "div") {}
    checked = false;
    hidden = false;
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
    window: { confirm },
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
    await get("confirm-publish").dispatch();
  assert.match(get("message").textContent, /发布成功/);
  assert.match(get("message").textContent, /列表刷新失败/);
  assert.equal(get("version-id").textContent, "new-version");
  assert.equal(get("publish").disabled, true);
  await get("form").dispatch("submit");
    await get("confirm-publish").dispatch();
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
    await get("list").querySelectorAll("button")[0]!.dispatch();
    assert.deepEqual(get("agents-md").querySelectorAll("textarea").map(input=>input.value),agentsMd);
    assert.ok(get("agents-md").querySelectorAll("textarea").every(input=>input.disabled));
    assert.equal(get("add-agents-md").disabled,true);
    await get("clone").dispatch();
    assert.ok(get("agents-md").querySelectorAll("textarea").every(input=>!input.disabled));
    await get("form").dispatch("submit");
    await get("confirm-publish").dispatch();
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
      const {expectedRevision,...value} = JSON.parse(options!.body as string);saved = value;return Response.json({agentDefaults:saved,defaultsRevision:expectedRevision+1});
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

test("clearing restricted users never broadens access; all-tenant transitions require confirmation", async () => {
  let approve = false, confirmations = 0;
  const changes: string[][] = [];
  const version = {
    id:"access-version",enabled:true,publishedAt:new Date().toISOString(),digest:"test",allowedUsers:["alice"],
    config:{name:"Test",systemPrompt:"",agentsMd:[],model:{provider:"demo",modelId:"demo"},tools:[],skills:[],mcpServers:[],subagents:[],skillBundle:"default",maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1},
  };
  const get = consoleController(async (url,options) => {
    if (options?.method === "PUT") {
      version.allowedUsers = JSON.parse(options.body as string).allowedUsers;
      changes.push(version.allowedUsers);return Response.json({allowedUsers:version.allowedUsers});
    }
    return Response.json({items:String(url).includes("/agents?") ? [version] : []});
  },()=>{confirmations++;return approve;});
  get("token").value = "test-admin-token";await get("connect").dispatch();
  await get("list").querySelectorAll("button")[0]!.dispatch();
  assert.equal(get("access-mode").value,"restricted");
  get("allowed-users").value = "";await get("save-access").dispatch();
  assert.equal(changes.length,0);assert.equal(confirmations,0);
  assert.match(get("message").textContent,/至少需要一个用户/);
  get("access-mode").value = "all";await get("access-mode").dispatch("change");
  assert.equal(get("allowed-users").disabled,true);
  await get("save-access").dispatch();assert.equal(changes.length,0);assert.equal(confirmations,1);
  approve = true;await get("save-access").dispatch();assert.deepEqual(changes,[[]]);
  get("access-mode").value = "restricted";await get("access-mode").dispatch("change");
  assert.equal(get("allowed-users").disabled,false);
  get("allowed-users").value = "bob\nbob";await get("save-access").dispatch();
  assert.deepEqual(changes,[[],["bob"]]);
});

test("refresh updates pristine defaults and warns/preserves dirty drafts after another client's update", async () => {
  let server = {model:{provider:"demo",modelId:"demo"},tools:["read"],skillBundle:"default",maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1};
  let saves=0, approve=true;
  const get = consoleController(async (url,options) => {
    if (options?.method === "PUT") {saves++;return Response.json(server);}
    if (String(url).endsWith("/configuration")) return Response.json({agentDefaults:server,deployment:{bundles:["default"]}});
    return Response.json({items:[]});
  },()=>approve);
  get("token").value = "test-admin-token";await get("connect").dispatch();
  server = {...server,maxSteps:40,tools:["bash"]};await get("refresh-console").dispatch();
  assert.equal(get("default-steps").value,"40");
  assert.deepEqual(get("default-tools").querySelectorAll("input:checked").map(input=>input.value),["bash"]);
  assert.equal(get("defaults-conflict").hidden,true);
  get("default-steps").value = "51";
  server = {...server,maxSteps:42};await get("refresh-console").dispatch();
  assert.equal(get("default-steps").value,"51");assert.match(get("defaults-conflict").textContent,/其他管理员更新/);
  approve=false;await get("defaults-form").dispatch("submit");assert.equal(saves,0);
  await get("reload-defaults").dispatch();assert.equal(get("default-steps").value,"51");
  approve=true;await get("reload-defaults").dispatch();assert.equal(get("default-steps").value,"42");
  assert.equal(get("defaults-conflict").hidden,true);
  // Editing and reverting is pristine again, so a subsequent refresh loads new server values.
  get("default-steps").value="55";get("default-steps").value="42";
  server={...server,maxSteps:43};await get("refresh-console").dispatch();assert.equal(get("default-steps").value,"43");
});

test("stale defaults save returns conflict without overwriting, preserves draft and requires explicit revision-aware retry", async () => {
  let revision=0, approve=true;
  let server = {model:{provider:"demo",modelId:"demo"},tools:["read"],skillBundle:"default",maxSteps:30,maxTokens:100000,timeoutSeconds:600,maxSubagents:2,maxDepth:1};
  const attempts:number[]=[];
  const get = consoleController(async (url,options) => {
    if (options?.method === "PUT") {
      const {expectedRevision,...value} = JSON.parse(options.body as string);attempts.push(expectedRevision);
      if (expectedRevision !== revision) return Response.json({error:{code:"DEFAULTS_CONFLICT"}},{status:409});
      server=value;revision++;return Response.json({agentDefaults:server,defaultsRevision:revision});
    }
    if (String(url).endsWith("/configuration")) return Response.json({agentDefaults:server,defaultsRevision:revision,deployment:{bundles:["default"]}});
    return Response.json({items:[]});
  },()=>approve);
  get("token").value="test-admin-token";await get("connect").dispatch();get("default-steps").value="51";
  // Another client saves while this page has not refreshed.
  server={...server,maxSteps:42};revision=1;
  await get("defaults-form").dispatch("submit");
  assert.deepEqual(attempts,[0]);assert.equal(server.maxSteps,42);assert.equal(get("default-steps").value,"51");
  assert.equal(get("defaults-conflict").hidden,false);assert.match(get("message").textContent,/保存冲突/);
  approve=false;await get("defaults-form").dispatch("submit");assert.deepEqual(attempts,[0]);
  // Yet another write between conflict discovery and confirmed retry must also be rejected.
  approve=true;revision=2;server={...server,maxSteps:43};await get("defaults-form").dispatch("submit");
  assert.deepEqual(attempts,[0,1]);assert.equal(server.maxSteps,43);assert.equal(get("default-steps").value,"51");
  await get("defaults-form").dispatch("submit");
  assert.deepEqual(attempts,[0,1,2]);assert.equal(server.maxSteps,51);assert.equal(revision,3);
  assert.equal(get("defaults-conflict").hidden,true);assert.match(get("message").textContent,/默认值已保存/);
});

const editorConfig = {
  name: "Editor agent",
  systemPrompt: "Original",
  agentsMd: ["# Rules\n\n- Preserve"],
  model: { provider: "demo", modelId: "demo" },
  tools: ["read"],
  skills: [],
  mcpServers: [],
  subagents: [],
  skillBundle: "default",
  maxSteps: 30,
  maxTokens: 100000,
  timeoutSeconds: 600,
  maxSubagents: 2,
  maxDepth: 1,
};
const editorVersion = {
  id: "version-one",
  agentId: "logical-one",
  activeVersionId: "version-one",
  config: editorConfig,
  enabled: true,
  allowedUsers: ["alice"],
  publishedAt: "2026-10-13T00:00:00Z",
  digest: "test",
};

function editorResponse(url: unknown) {
  return Response.json(
    String(url).endsWith("/configuration")
      ? {
          agentDefaults: {
            model: editorConfig.model,
            tools: editorConfig.tools,
            skillBundle: "default",
            maxSteps: 30,
            maxTokens: 100000,
            timeoutSeconds: 600,
            maxSubagents: 2,
            maxDepth: 1,
          },
          deployment: {
            models: [editorConfig.model],
            bundles: ["default"],
            endpoints: [],
          },
        }
      : {
          items: String(url).includes("/admin/agents?") ? [editorVersion] : [],
        },
  );
}

test("review shows only changed fields and cannot publish a configuration edited after review", async () => {
  let writes = 0;
  const get = consoleController(async (url, options) => {
    if (options?.method === "POST") {
      writes++;
      return Response.json({
        ...editorVersion,
        id: "version-two",
        config: JSON.parse(options.body as string),
      });
    }
    return editorResponse(url);
  });
  get("token").value = "admin";
  await get("connect").dispatch();
  await get("list").querySelectorAll("button")[0]!.dispatch();
  await get("clone").dispatch();
  get("prompt").value = "Updated";
  await get("form").dispatch("submit");
  assert.equal(writes, 0);
  assert.equal(get("publish-review").hidden, false);
  assert.match(get("review-diff").textContent, /Original/);
  assert.match(get("review-diff").textContent, /Updated/);
  assert.doesNotMatch(get("review-diff").textContent, /skillBundle/);
  assert.match(get("review-warning").textContent, /ACL/);
  get("prompt").value = "Changed again";
  await get("confirm-publish").dispatch();
  assert.equal(writes, 0);
  assert.equal(get("publish-review").hidden, true);
  await get("form").dispatch("submit");
  await get("confirm-publish").dispatch();
  assert.equal(writes, 1);
});

test("refresh retains the original dirty baseline and cancelled navigation or disconnect preserves the draft", async () => {
  let approve = false,
    prompts = 0;
  const get = consoleController(
    async (url) => editorResponse(url),
    () => {
      prompts++;
      return approve;
    },
  );
  get("token").value = "admin";
  await get("connect").dispatch();
  get("name").value = "Unsaved";
  await get("refresh-console").dispatch();
  await get("new").dispatch();
  assert.equal(get("name").value, "Unsaved");
  await get("list").querySelectorAll("button")[0]!.dispatch();
  assert.equal(get("name").value, "Unsaved");
  await get("disconnect").dispatch();
  assert.equal(get("connection").textContent, "已连接");
  assert.equal(prompts, 3);
  approve = true;
  await get("new").dispatch();
  assert.equal(get("name").value, "");
});

for (const status of [400, 403, 409, 500, 503]) {
  test(`HTTP ${status} publication failure preserves the draft and allows an explicit retry`, async () => {
    const get = consoleController(async (url, options) =>
      options?.method === "POST"
        ? Response.json(
            { error: { code: `TEST_${status}`, message: "Rejected" } },
            { status },
          )
        : editorResponse(url),
    );
    get("token").value = "admin";
    await get("connect").dispatch();
    get("name").value = "Unsaved";
    await get("form").dispatch("submit");
    await get("confirm-publish").dispatch();
    assert.equal(get("name").value, "Unsaved");
    assert.equal(get("connection").textContent, "已连接");
    assert.match(get("message").textContent, new RegExp(`TEST_${status}`));
    assert.equal(get("confirm-publish").disabled, false);
  });
}

test("expired token clears the connection and late parallel responses cannot restore tenant data", async () => {
  let expired = false;
  const pending: ((value: Response) => void)[] = [];
  const get = consoleController(async (url) => {
    if (!expired) return editorResponse(url);
    if (String(url).includes("/skills?"))
      return Response.json(
        { error: { code: "UNAUTHENTICATED" } },
        { status: 401 },
      );
    return new Promise<Response>((resolve) => pending.push(resolve));
  });
  get("token").value = "admin";
  await get("connect").dispatch();
  expired = true;
  await get("refresh-console").dispatch();
  assert.equal(get("connection").textContent, "未连接");
  assert.equal(get("count").textContent, "0");
  assert.match(get("message").textContent, /令牌已过期或无效/);
  for (const resolve of pending) resolve(editorResponse("/admin/agents?"));
  await Promise.resolve();
  assert.equal(get("count").textContent, "0");
  assert.equal(get("publish").disabled, true);
});

test("responses from a previous tenant connection cannot replace the new connection", async () => {
  const old: ((value: Response) => void)[] = [];
  const get = consoleController(async (url, options) => {
    if (
      (options!.headers as Record<string, string>).Authorization ===
      "Bearer old"
    )
      return new Promise<Response>((resolve) => old.push(resolve));
    return editorResponse(url);
  });
  get("token").value = "old";
  const first = get("connect").dispatch();
  await get("disconnect").dispatch();
  get("token").value = "new";
  await get("connect").dispatch();
  for (const resolve of old) resolve(Response.json({ items: [] }));
  await first;
  assert.equal(get("connection").textContent, "已连接");
  assert.match(get("count").textContent, /1 Agents/);
});

test("pending access edits survive refresh and new restricted users require confirmation", async () => {
  let approve = false, writes = 0;
  const get = consoleController(async (url, options) => {
    if (options?.method === "PUT") { writes++; return Response.json({}); }
    return editorResponse(url);
  }, () => approve);
  get("token").value = "admin"; await get("connect").dispatch();
  await get("list").querySelectorAll("button")[0]!.dispatch();
  get("allowed-users").value = "alice\nbob";
  await get("refresh-console").dispatch();
  assert.equal(get("allowed-users").value, "alice\nbob");
  await get("new").dispatch();
  assert.equal(get("version-id").textContent, editorVersion.id);
  await get("save-access").dispatch();
  assert.equal(writes, 0);
  approve = true; await get("save-access").dispatch();
  assert.equal(writes, 1);
});

test("disconnect removes sensitive configuration from the hidden review and version details", async () => {
  const get = consoleController(async url => editorResponse(url));
  get("token").value = "admin"; await get("connect").dispatch();
  await get("list").querySelectorAll("button")[0]!.dispatch();
  await get("clone").dispatch();
  get("prompt").value = "Tenant-private draft";
  await get("form").dispatch("submit");
  assert.match(get("review-diff").textContent, /Tenant-private/);
  await get("disconnect").dispatch();
  assert.equal(get("review-diff").textContent, "");
  assert.equal(get("review-summary").textContent, "");
  assert.equal(get("allowed-users").value, "");
  assert.equal(get("version-id").textContent, "");
});
