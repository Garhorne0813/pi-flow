import { Fault } from "../domain/model.js";
import { EvalTraceAdapter } from "./trace.js";
export const mockNames = ["read", "ls", "grep", "find"] as const;
export type MockTools = Partial<Record<(typeof mockNames)[number], unknown>>;
export class EvalToolGateway {
  readonly trace = new EvalTraceAdapter();
  constructor(
    readonly mocks: MockTools,
    private allowed: string[],
    private authorize: (name: string) => Promise<void>,
  ) {}
  specs() {
    return Object.keys(this.mocks)
      .filter((n) => this.allowed.includes(n))
      .map((name) => ({
        name,
        description: `Isolated evaluation mock: ${name}`,
        schema: { type: "object", additionalProperties: true },
      }));
  }
  async call(name: string, args: Record<string, unknown>, callId?: string) {
    const call = this.trace.start(name, args, callId);
    try {
      if (
        !mockNames.includes(name as (typeof mockNames)[number]) ||
        !this.allowed.includes(name) ||
        !Object.hasOwn(this.mocks, name)
      )
        throw new Fault(403, "EVAL_TOOL_DENIED");
      await this.authorize(name);
      call.status = "COMPLETED";
      // These arguments are suite-owned data, visible only via authenticated case details.
      const safe = (v: unknown, depth = 0): unknown => {
        if (depth > 5) return "[TRUNCATED]";
        if (typeof v === "string") return v.slice(0, 1000);
        if (Array.isArray(v))
          return v.slice(0, 20).map((x) => safe(x, depth + 1));
        if (v && typeof v === "object")
          return Object.fromEntries(
            Object.entries(v)
              .slice(0, 20)
              .map(([k, x]) => [
                k,
                /token|secret|password|authorization|cookie|key/i.test(k)
                  ? "[REDACTED]"
                  : safe(x, depth + 1),
              ]),
          );
        return v;
      };
      call.args = safe(args) as Record<string, unknown>;
      return structuredClone(this.mocks[name as keyof MockTools]);
    } catch (e) {
      call.status = "DENIED";
      call.errorCode = e instanceof Fault ? e.code : "EVAL_TOOL_FAILED";
      throw e;
    }
  }
}
