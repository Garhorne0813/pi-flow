export interface Frame {
  event: string;
  data: string;
  id?: string;
}
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Frame> {
  const reader = stream.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    event = "message",
    data: string[] = [],
    id: string | undefined,
    skipLF = false;
  function line(value: string): Frame | undefined {
    if (!value) {
      const frame = data.length
        ? { event, data: data.join("\n"), id }
        : undefined;
      event = "message";
      data = [];
      return frame;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":"),
      field = colon < 0 ? value : value.slice(0, colon),
      raw = colon < 0 ? "" : value.slice(colon + 1),
      v = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = v;
    if (field === "data") data.push(v);
    if (field === "id" && !v.includes("\0")) id = v;
  }
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        if (skipLF) {
          skipLF = false;
          if (pending[i] === "\n") {
            start = i + 1;
            continue;
          }
        }
        if (pending[i] === "\r" || pending[i] === "\n") {
          const f = line(pending.slice(start, i));
          skipLF = pending[i] === "\r";
          start = i + 1;
          if (f) yield f;
        }
      }
      pending = pending.slice(start);
      if (pending.length + data.reduce((n, s) => n + s.length, 0) > 1048576)
        throw new Error("SSE_FRAME_TOO_LARGE");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
