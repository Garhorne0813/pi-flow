import test from "node:test";
import assert from "node:assert/strict";
import { AgentConfig, Fault } from "../src/domain/model.js";
import { EvalCase } from "../src/evals/types.js";
import { EvalExecutor } from "../src/evals/executor.js";
import { EvalToolGateway } from "../src/evals/tool-gateway.js";
import { checkUsageCaps } from "../src/domain/usage-budget.js";
import { UsagePolicy } from "../src/domain/usage.js";
const config = AgentConfig.parse({
  name: "eval",
  systemPrompt: "test",
  model: { provider: "demo", modelId: "demo" },
  tools: ["read", "bash"],
  userTokenAccess: true,
  skills: ["production"],
  mcpServers: ["prod"],
});
const c = EvalCase.parse({
  caseId: "c",
  inputs: "hi",
  graders: [{ id: "g", type: "exact", expected: "ok" }],
});
test("eval executor has fresh entries and no production capabilities, and captures the last complete final message", async () => {
  const executor = new EvalExecutor({
    async execute(ctx) {
      assert.deepEqual(ctx.entries, []);
      assert.deepEqual(ctx.skills, []);
      assert.deepEqual(ctx.config.mcpServers, []);
      assert.equal(ctx.config.userTokenAccess, false);
      assert.deepEqual(ctx.config.tools, ["read"]);
      assert.deepEqual(
        await ctx.call("read", { path: "/fixture", token: "secret" }, "sdk-id"),
        { text: "fixture" },
      );
      await ctx.emit("message.delta", { delta: "ignore" });
      await ctx.emit("message.completed", {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "first" }],
        },
      });
      await ctx.emit("message.completed", {
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "ok" }],
        },
      });
    },
  });
  const r = await executor.execute({
    config,
    case: c,
    mocks: { read: { text: "fixture" } },
    signal: new AbortController().signal,
    authorize: async () => {},
    budget: {},
  });
  assert.equal(r.output, "ok");
  assert.equal(r.trajectory[0]!.callId, "sdk-id");
  assert.equal(r.trajectory[0]!.args!.token, "[REDACTED]");
});
test("eval tool policy denies shell/MCP and live revocation, including directly dispatched hidden tools", async () => {
  const g = new EvalToolGateway({ read: "ok" }, ["read", "bash"], async () => {
    throw new Fault(403, "KILL_SWITCH");
  });
  await assert.rejects(g.call("bash", { command: "env" }));
  await assert.rejects(g.call("read", {}));
  assert.deepEqual(
    g.trace.calls.map((c) => c.status),
    ["DENIED", "DENIED"],
  );
  assert.equal(g.trace.calls[0]!.args, undefined);
});
test("eval incomplete final messages are execution errors; common budget caps include reserved/unknown usage", async () => {
  const executor = new EvalExecutor({
    async execute(ctx) {
      await ctx.emit("message.completed", {
        message: {
          role: "assistant",
          stopReason: "length",
          content: "partial",
        },
      });
    },
  });
  await assert.rejects(
    executor.execute({
      config,
      case: c,
      mocks: {},
      signal: new AbortController().signal,
      authorize: async () => {},
      budget: {},
    }),
    /FINAL_MESSAGE_MISSING/,
  );
  assert.throws(
    () =>
      checkUsageCaps(
        [],
        UsagePolicy.parse({ userDailyTokens: 10 }),
        "u",
        11,
        null,
      ),
    /MODEL_BUDGET_EXCEEDED/,
  );
});
