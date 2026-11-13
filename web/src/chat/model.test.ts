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

describe("history ordering and live updates", () => {
  const required = {
    id: "event:10",
    kind: "interaction",
    runId: "a",
    interactionId: "q",
    resolved: false,
  };
  const resolved = {
    id: "event:20",
    kind: "resolved",
    runId: "a",
    interactionId: "q",
  };
  const started = {
    id: "event:11",
    kind: "tool",
    runId: "a",
    callId: "call",
    name: "bash",
    state: "started",
  };
  const completed = {
    ...started,
    id: "event:21",
    state: "completed",
    name: "",
  };
  it("retains an orphan resolution across separate pages in either load order", () => {
    for (const pages of [
      [resolved, required],
      [required, resolved],
    ]) {
      const firstPage = mergeHistory([pages[0]]);
      const merged = mergeHistory([...firstPage, pages[1]]);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ kind: "interaction", resolved: true });
      expect(required.resolved).toBe(false);
    }
  });
  it("merges out-of-order tool events by sequence and retains the tool name", () => {
    for (const events of [
      [started, completed],
      [completed, started],
    ]) {
      expect(mergeHistory(events)[0]).toMatchObject({
        eventId: 21,
        state: "completed",
        name: "bash",
      });
    }
  });
  it("does not let a delayed history response overwrite newer SSE state", async () => {
    let release!: (items: (typeof started)[]) => void;
    const response = new Promise<(typeof started)[]>((resolve) => {
      release = resolve;
    });
    let state = reduce(
      empty,
      event(11, "tool.started", { callId: "call", name: "bash" }),
    );
    const history = response.then((items) => {
      state = { ...state, items: mergeHistory([...state.items, ...items]) };
    });
    state = reduce(state, event(21, "tool.completed", { callId: "call" }));
    release([started]);
    await history;
    expect(state.items[0]).toMatchObject({
      eventId: 21,
      state: "completed",
      name: "bash",
    });
  });
  it("retains SSE resolution before history supplies its request", () => {
    const state = reduce(
      empty,
      event(20, "interaction.resolved", { interactionId: "q" }),
    );
    expect(mergeHistory([...state.items, required])[0]).toMatchObject({
      resolved: true,
    });
    const history = { ...empty, items: mergeHistory([resolved]) };
    const live = reduce(
      history,
      event(10, "interaction.required", {
        interaction: { id: "q", kind: "approval" },
      }),
    );
    expect(live.items[0]).toMatchObject({
      kind: "interaction",
      resolved: true,
    });
  });
  it("keeps resolved state when stale requests return, without affecting another run", () => {
    const resolvedItems = mergeHistory([required, resolved]);
    const merged = mergeHistory([
      ...resolvedItems,
      required,
      { ...required, runId: "b" },
    ]);
    expect(merged.find((x) => x.runId === "a")?.resolved).toBe(true);
    expect(merged.find((x) => x.runId === "b")?.resolved).toBe(false);
  });
});
