import { describe, it, expect } from "vitest";
import { empty, reduce, mergeHistory, type PiEvent } from "./model";
const event = (
  id: number,
  type: string,
  data: unknown,
  runId = "a",
): PiEvent => ({
  eventId: id,
  type,
  data,
  runId,
  sessionId: "s",
  timestamp: "now",
});
describe("run projection", () => {
  it("deduplicates replay, replaces only the current segment and isolates run cursors", () => {
    let s = reduce(empty, event(1, "message.delta", { delta: "draft" }));
    s = reduce(s, event(1, "message.delta", { delta: "draft" }));
    expect(s.drafts.a).toBe("draft");
    s = reduce(
      s,
      event(2, "message.completed", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
      }),
    );
    s = reduce(s, event(3, "message.delta", { delta: "second" }));
    s = reduce(
      s,
      event(4, "message.completed", {
        message: { role: "assistant", content: "second" },
      }),
    );
    s = reduce(s, event(1, "message.delta", { delta: "child" }, "b"));
    expect(s.items.map((x) => x.text)).toEqual(["first", "second"]);
    expect(s.drafts).toEqual({ b: "child" });
    expect(s.cursors).toEqual({ a: 4, b: 1 });
  });
  it("merges tool lifecycle and resolution across history pages", () => {
    const items = mergeHistory([
      {
        id: "1",
        kind: "tool",
        runId: "a",
        callId: "x",
        name: "bash",
        state: "started",
      },
      { id: "2", kind: "tool", runId: "a", callId: "x", state: "completed" },
      { id: "3", kind: "interaction", runId: "a", interactionId: "q" },
      { id: "4", kind: "resolved", runId: "a", interactionId: "q" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("bash");
    expect(items[0].state).toBe("completed");
    expect(items[1].resolved).toBe(true);
  });
  it("ignores unknown events without crashing", () =>
    expect(reduce(empty, event(1, "future.event", null)).items).toEqual([]));
});
