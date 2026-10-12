import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentConfig } from "../src/domain.js";
import {
  EnterpriseResourceLoader,
  PiRuntime,
  type RuntimeContext,
} from "../src/runtime.js";
import { specs } from "../src/tool-specs.js";
test("real Pi 0.99.2 uses canonical custom read/bash and restores legacy session entries", async () => {
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
              name: "read",
              arguments: '{"path":"hello.txt"}',
            },
          },
          {
            index: 1,
            id: "call_bash",
            type: "function",
            function: {
              name: "bash",
              arguments: '{"command":"exit 73","timeoutSeconds":60}',
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ content: "Remote content verified." });
      chunk({}, "stop");
    }
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
    );
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
    const recordedUsage: unknown[] = [];
    let reservedRequests = 0;
    const cfg = AgentConfig.parse({
      name: "test",
      systemPrompt: "Use read and bash in the sandbox.",
      model: { provider: "test-gateway", modelId: "test-model" },
      tools: ["read", "bash"],
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
      beforeModelRequest: async (estimate) => {
        assert.ok(estimate > 0);
        return { id: "request-" + ++reservedRequests, maxOutputTokens: 12 };
      },
      recordModelUsage: async (_id, usage) => {
        recordedUsage.push(usage);
      },
      call: async (name, args) => {
        if (name === "read") {
          assert.deepEqual(args, { path: "hello.txt" });
        } else {
          assert.equal(name, "bash");
          assert.equal(args.command, "exit 73");
        }
        calls++;
        return { text: `remote-only-${name}` };
      },
      emit: async (type) => {
        events.push(type);
      },
      checkpoint: async (next) => {
        entries = next;
      },
    });
    await runtime.execute(context());
    assert.equal(calls, 2);
    assert.ok(
      entries.some(
        (e: any) => e.type === "message" && e.message.role === "toolResult",
      ),
    );
    assert.ok(events.includes("message.delta"));
    for (const req of requests) {
      assert.equal(req.max_tokens ?? req.max_completion_tokens, 12);
      const names = req.tools.map((t: any) => t.function.name);
      assert.deepEqual(names, ["read", "bash"]);
    }
    assert.ok(
      !requests[0]!.messages.some((m: any) =>
        String(m.content).includes("SKILL.md"),
      ),
    );
    // Simulate pre-rename persisted tool calls/results without rewriting IDs or history.
    entries = entries.map((entry: any) => {
      if (entry.type !== "message") return entry;
      const message = entry.message;
      if (message.role === "assistant")
        return {
          ...entry,
          message: {
            ...message,
            content: message.content.map((block: any) =>
              block.type === "toolCall"
                ? { ...block, name: `remote_${block.name}` }
                : block,
            ),
          },
        };
      if (message.role === "toolResult")
        return {
          ...entry,
          message: { ...message, toolName: `remote_${message.toolName}` },
        };
      return entry;
    });
    const legacyEntries = structuredClone(entries);
    const restored = SessionManager.inMemory(
      "/harness",
      undefined,
      entries as any,
    );
    assert.ok(restored.getEntries().length > 0);
    await runtime.execute({ ...context(), prompt: "Continue" });
    assert.equal(calls, 2);
    const resumedRequest = requests.at(-1)!;
    assert.deepEqual(
      resumedRequest.tools.map((t: any) => t.function.name),
      ["read", "bash"],
    );
    assert.deepEqual(
      resumedRequest.messages.flatMap((m: any) =>
        (m.tool_calls ?? []).map((t: any) => t.function.name),
      ),
      ["remote_read", "remote_bash"],
    );
    assert.deepEqual(entries.slice(0, legacyEntries.length), legacyEntries);
    for (const name of ["read", "bash"])
      assert.ok(
        resumedRequest.messages.some(
          (m: any) =>
            m.role === "tool" &&
            String(m.content).includes(`remote-only-${name}`),
        ),
      );
    assert.equal(recordedUsage.length, requests.length);
    assert.ok(recordedUsage.every((u: any) => u.totalTokens === 7));
    const beforeDenied = requests.length;
    await assert.rejects(
      runtime.execute({
        ...context(),
        beforeModelRequest: async () => {
          throw new Error("budget denied");
        },
      }),
    );
    assert.equal(
      requests.length,
      beforeDenied,
      "budget refusal must precede gateway dispatch",
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

test("sandbox tool specs expose canonical names and retain auxiliary tool names", () => {
  const names = [
    "read",
    "write",
    "edit",
    "bash",
    "ls",
    "find",
    "grep",
    "todo",
    "ask_user_question",
    "delegate_to_agent",
  ];
  assert.deepEqual(
    specs(names).map((tool) => tool.name),
    names,
  );
  assert.deepEqual(
    specs(["read"]).map((tool) => tool.name),
    ["read"],
  );
  const config = AgentConfig.parse({
    name: "test",
    systemPrompt: "safe",
    model: { provider: "demo", modelId: "demo" },
    tools: ["read"],
    skillBundle: "default",
  });
  const loader = new EnterpriseResourceLoader(config, [
    {
      id: "probe",
      name: "probe",
      description: "test skill",
      path: "/skills/probe/SKILL.md",
      digest: "a".repeat(64),
      bundle: "default",
      enabled: true,
    },
  ]);
  assert.ok(
    loader
      .getAppendSystemPrompt()
      .some((line) => line.includes("with read when needed")),
  );
  assert.ok(
    loader
      .getAppendSystemPrompt()
      .every((line) => !line.includes("remote_read")),
  );
});
