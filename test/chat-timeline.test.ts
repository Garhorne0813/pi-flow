import test from "node:test";
import assert from "node:assert/strict";
import { chatItem, messageText } from "../src/api/chat-timeline.js";
test("chat projection excludes tool arguments, results and private fields", () => {
  const projected = chatItem({
    eventId: 1,
    runId: "r",
    timestamp: "now",
    type: "tool.completed",
    data: {
      name: "bash",
      callId: "c",
      args: { token: "secret" },
      result: "secret",
      capabilities: { secret: "secret" },
    },
  });
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  assert.equal(
    messageText({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
      ],
    }),
    "visible",
  );
  assert.equal(messageText({ role: "user", content: "hidden" }), "");
});
