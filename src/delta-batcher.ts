import { Fault } from "./domain.js";
export class DeltaBatcher {
  private text = "";
  private pendingChars = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private error?: unknown;
  constructor(
    private persist: (type: string, data: unknown) => Promise<void>,
    private failed: (error: unknown) => void,
    private maxChars = 16384,
    private maxPendingChars = 131072,
    private delayMs = 200,
    private persistBatch?: (
      events: { type: string; data: unknown }[],
    ) => Promise<void>,
  ) {}
  push(delta: string) {
    if (this.error) throw this.error;
    if (
      this.pendingChars + this.text.length + delta.length >
      this.maxPendingChars
    )
      throw new Fault(503, "STREAM_BACKPRESSURE_LIMIT");
    this.text += delta;
    if (this.text.length >= this.maxChars) this.schedule();
    else if (!this.timer)
      this.timer = setTimeout(() => this.schedule(), this.delayMs);
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const events: { type: string; data: unknown }[] = [];
    while (this.text.length) {
      const delta = this.text.slice(0, this.maxChars);
      this.text = this.text.slice(delta.length);
      events.push({ type: "message.delta", data: { delta } });
    }
    if (!events.length) return;
    const chars = events.reduce(
      (n, e) => n + (e.data as { delta: string }).delta.length,
      0,
    );
    this.pendingChars += chars;
    const task = this.tail
      .then(async () => {
        if (this.error) throw this.error;
        if (this.persistBatch) await this.persistBatch(events);
        else for (const e of events) await this.persist(e.type, e.data);
      })
      .finally(() => {
        this.pendingChars -= chars;
      });
    this.tail = task;
    void task.catch((e) => {
      if (!this.error) {
        this.error = e;
        this.failed(e);
      }
    });
  }

  async flush() {
    this.schedule();
    await this.tail;
    if (this.error) throw this.error;
  }
  async emit(type: string, data: unknown) {
    if (type === "message.delta") {
      this.push((data as { delta: string }).delta);
      return;
    }
    await this.flush();
    if (this.persistBatch) await this.persistBatch([{ type, data }]);
    else await this.persist(type, data);
  }
}
