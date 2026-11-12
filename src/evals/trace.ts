import { randomUUID } from "node:crypto";
import { digest } from "./dataset.js";
import type { ToolCallRecord } from "./types.js";
// Default trace carries hashes only. Explicit safe scalar fields are optional.
export class EvalTraceAdapter {
  readonly calls: ToolCallRecord[] = [];
  private sequence = 0;
  start(
    name: string,
    args: Record<string, unknown>,
    callId: string = randomUUID(),
  ) {
    if (this.calls.length >= 100) throw new Error("EVAL_TOOL_LIMIT");
    const call: ToolCallRecord = {
      sequence: ++this.sequence,
      callId,
      name,
      argsDigest: digest(args),
      status: "FAILED",
    };
    this.calls.push(call);
    return call;
  }
}
