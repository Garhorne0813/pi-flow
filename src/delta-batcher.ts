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
    private maxChars = 4096,
    private maxPendingChars = 131072,
    private delayMs = 50,
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
    while (this.text.length) {
      const delta = this.text.slice(0, this.maxChars);
      this.text = this.text.slice(delta.length);
      this.pendingChars += delta.length;
      const task = this.tail
        .then(() => {
          if (this.error) throw this.error;
          return this.persist("message.delta", { delta });
        })
        .finally(() => {
          this.pendingChars -= delta.length;
        });
      this.tail = task;
      void task.catch((e) => {
        if (!this.error) {
          this.error = e;
          this.failed(e);
        }
      });
    }
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
    await this.persist(type, data);
  }
}
