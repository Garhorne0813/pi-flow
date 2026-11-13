import { it, expect } from "vitest";
import { parseSSE } from "./sse";
it("handles every byte boundary, UTF8, comments, CRLF, multiline, and ignores incomplete tails", async () => {
  const bytes = new TextEncoder().encode(
    ": heartbeat\r\nid: 8\r\nevent: test\r\ndata: 你好\r\ndata: world\r\n\r\ndata: incomplete",
  );
  const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    }),
    frames = [];
  for await (const frame of parseSSE(stream)) frames.push(frame);
  expect(frames).toEqual([{ id: "8", event: "test", data: "你好\nworld" }]);
});
it("releases reader on malformed oversized frames", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(1048577).fill(65));
      c.close();
    },
  });
  await expect(async () => {
    for await (const frame of parseSSE(stream)) void frame;
  }).rejects.toThrow("SSE_FRAME_TOO_LARGE");
  expect(stream.locked).toBe(false);
});
