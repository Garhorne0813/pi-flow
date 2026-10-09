import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentConfig } from "../src/domain.js";
import { PiRuntime, type RuntimeContext } from "../src/runtime.js";
import { specs } from "../src/tool-specs.js";
test("real Pi 0.99.2 uses only remote tools and restores canonical session entries", async () => {
  const requests: Record<string, any>[] = [];
  let count = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const request = JSON.parse(body);
    requests.push(request);
    count++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "completion-" + count, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: "assistant" });
    if (count === 1) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: {
              name: "remote_read",
              arguments: '{"path":"hello.txt"}',
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: "Remote content verified." });
      chunk({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const mr = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    mr.registerProvider("test-gateway", {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "test-key",
      models: [
        {
          id: "test-model",
          name: "test",
          input: ["text"],
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const runtime = new PiRuntime(mr);
    let entries: unknown[] = [];
    let calls = 0;
    const events: string[] = [];
    const cfg = AgentConfig.parse({
      name: "test",
      systemPrompt: "Use remote_read to read the file.",
      model: { provider: "test-gateway", modelId: "test-model" },
      tools: ["read"],
      skillBundle: "default",
    });
    const context = (): RuntimeContext => ({
      config: cfg,
      entries,
      prompt: "Read hello.txt",
      skills: [],
      specs: specs(cfg.tools),
      signal: new AbortController().signal,
      consume: async () => {},
      call: async (name, args) => {
        assert.equal(name, "remote_read");
        assert.deepEqual(args, { path: "hello.txt" });
        calls++;
        return { text: "remote-only" };
      },
      emit: async (type) => {
        events.push(type);
      },
      checkpoint: async (next) => {
        entries = next;
      },
    });
    await runtime.execute(context());
    assert.equal(calls, 1);
    assert.ok(
      entries.some(
        (e: any) => e.type === "message" && e.message.role === "toolResult",
      ),
    );
    assert.ok(events.includes("message.delta"));
    for (const req of requests) {
      const names = req.tools.map((t: any) => t.function.name);
      assert.deepEqual(names, ["remote_read"]);
    }
    assert.ok(
      !requests[0]!.messages.some((m: any) =>
        String(m.content).includes("SKILL.md"),
      ),
    );
    const restored = SessionManager.inMemory(
      "/harness",
      undefined,
      entries as any,
    );
    assert.ok(restored.getEntries().length > 0);
    await runtime.execute({ ...context(), prompt: "Continue" });
    assert.equal(calls, 1);
    assert.ok(
      requests
        .at(-1)!
        .messages.some(
          (m: any) =>
            m.role === "tool" && String(m.content).includes("remote-only"),
        ),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("configured native DeepSeek provider retains Pi reasoning and compatibility metadata", async () => {
  const names = ["LLM_PROVIDER", "LLM_MODEL_ID", "LLM_BASE_URL", "LLM_API_KEY"];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    process.env.LLM_PROVIDER = "deepseek";
    process.env.LLM_MODEL_ID = "deepseek-flash";
    process.env.LLM_BASE_URL = "https://api.deepseek.com/";
    delete process.env.LLM_API_KEY;
    const original = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const expected = original.getModel("deepseek", "deepseek-flash")!;
    const configured = await PiRuntime.create();
    const actual = (configured as any).modelRuntime.getModel(
      "deepseek",
      "deepseek-flash",
    );
    assert.equal(actual.reasoning, true);
    assert.equal(actual.contextWindow, expected.contextWindow);
    assert.deepEqual(actual.compat, expected.compat);
    assert.equal(actual.baseUrl, expected.baseUrl);
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
