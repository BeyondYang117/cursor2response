import { createHash } from "node:crypto";

interface Pending<T> {
  controller: AbortController;
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

/** Coalesce account-specific discovery without letting one caller cancel another. */
export class ModelCatalog<T> {
  private readonly cache = new Map<string, { value: T; expiresAt: number }>();
  private readonly pending = new Map<string, Pending<T>>();

  constructor(private readonly load: (apiKey: string, signal: AbortSignal) => Promise<T>) {}

  async get(apiKey: string, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const key = createHash("sha256").update(apiKey).digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.cache.delete(key);
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const current: Pending<T> = {
        controller, waiters: 0, settled: false,
        promise: Promise.resolve().then(() => this.load(apiKey, controller.signal)).then((value) => {
          controller.signal.throwIfAborted();
          this.cache.set(key, { value, expiresAt: Date.now() + 60_000 });
          while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
          return value;
        }).finally(() => {
          current.settled = true;
          if (this.pending.get(key) === current) this.pending.delete(key);
        })
      };
      entry = current;
      this.pending.set(key, current);
    }
    const current = entry;
    current.waiters++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal.removeEventListener("abort", abort);
        if (--current.waiters === 0 && !current.settled) {
          current.controller.abort();
          if (this.pending.get(key) === current) this.pending.delete(key);
        }
        return true;
      };
      const abort = () => { if (finish()) reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      current.promise.then(
        (value) => { if (finish()) resolve(value); },
        (error) => { if (finish()) reject(error); }
      );
    });
  }
}
