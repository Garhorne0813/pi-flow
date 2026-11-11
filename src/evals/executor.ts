import type { AgentConfig } from "../domain/model.js";
import type { Runtime, RuntimeContext } from "../execution/runtime.js";
import type { EvalCase } from "./types.js";
import { EvalToolGateway, type MockTools } from "./tool-gateway.js";
export type EvalModelCallbacks = Pick<
  RuntimeContext,
  "beforeModelRequest" | "recordModelUsage"
>;
export class EvalExecutor {
  readonly namespace = "eval";
  constructor(private runtime: Runtime) {}
  async execute(input: {
    config: AgentConfig;
    case: EvalCase;
    mocks: MockTools;
    signal: AbortSignal;
    authorize: (tool?: string) => Promise<void>;
    gateway?: RuntimeContext["gateway"];
    budget: EvalModelCallbacks;
  }) {
    await input.authorize();
    const tools = new EvalToolGateway(input.mocks, input.config.tools, (name) =>
      input.authorize(name),
    );
    let output: string | undefined,
      tokens = 0,
      steps = 0;
    const started = Date.now();
    // No workspace, sandbox provider, MCP client, user token, skill loader or memory is accepted here.
    const config: AgentConfig = {
      ...structuredClone(input.config),
      tools: input.config.tools.filter((t) =>
        tools.specs().some((s) => s.name === t),
      ),
      skills: [],
      mcpServers: [],
      subagents: [],
      subagentDefinitions: undefined,
      userTokenAccess: false,
      memory: {
        enabled: false,
        scopes: [],
        maxFileBytes: 100,
        maxTotalBytes: 100,
        maxFiles: 1,
        maxIndexBytes: 100,
        maxWritesPerRun: 1,
      },
      maxSubagents: 0,
      maxDepth: 0,
    };
    await this.runtime.execute({
      config,
      entries: [],
      skills: [],
      specs: tools.specs(),
      prompt: input.case.inputs,
      signal: input.signal,
      gateway: input.gateway,
      ...input.budget,
      call: async (name, args, callId) => {
        input.signal.throwIfAborted();
        return tools.call(name, args, callId);
      },
      checkpoint: async () => {},
      emit: async (type, data) => {
        input.signal.throwIfAborted();
        if (type !== "message.completed") return;
        const m = (
          data as {
            message?: { role?: string; stopReason?: string; content?: unknown };
          }
        )?.message;
        if (m?.role !== "assistant") return;
        output = undefined;
        // Intermediate tool-use, failed and truncated messages cannot be final answers.
        if (m.stopReason !== "stop") return;
        if (typeof m.content === "string") output = m.content;
        else if (Array.isArray(m.content))
          output = m.content
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("");
        if (output !== undefined && Buffer.byteLength(output) > 64000)
          throw new Error("EVAL_OUTPUT_LIMIT");
      },
      consume: async (n, turn) => {
        tokens += n;
        if (turn) steps++;
        if (tokens > config.maxTokens || steps > config.maxSteps)
          throw new Error("EVAL_EXECUTION_LIMIT");
      },
    });
    input.signal.throwIfAborted();
    if (output === undefined) throw new Error("EVAL_FINAL_MESSAGE_MISSING");
    return {
      output,
      trajectory: tools.trace.calls,
      metrics: { tokens, durationMs: Date.now() - started },
    };
  }
}
