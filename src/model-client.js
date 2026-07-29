export class ModelClient {
  #worker;
  #pending = new Map();
  #nextId = 0;

  constructor() {
    this.#worker = new Worker("./src/geometry-worker.js", { type: "module" });
    this.#worker.addEventListener("message", (event) => {
      const entry = this.#pending.get(event.data.id);
      if (!entry) return;
      this.#pending.delete(event.data.id);
      if (event.data.ok) {
        entry.resolve(event.data.payload);
      } else {
        const error = new Error(event.data.error?.message || "内核重算失败");
        error.name = event.data.error?.name || "KernelError";
        entry.reject(error);
      }
    });
    this.#worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "几何 Worker 加载失败");
      for (const entry of this.#pending.values()) entry.reject(error);
      this.#pending.clear();
    });
  }

  request(action, payload = {}) {
    const id = `model-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, action, payload });
    });
  }

  close() {
    this.#worker.terminate();
    this.#pending.clear();
  }
}
