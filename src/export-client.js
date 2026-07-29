export class ExportClient {
  #worker;
  #pending = new Map();
  #nextId = 0;

  constructor() {
    this.#worker = new Worker("./src/export-worker.js", { type: "module" });
    this.#worker.addEventListener("message", (event) => {
      const entry = this.#pending.get(event.data.id);
      if (!entry) return;
      this.#pending.delete(event.data.id);
      if (event.data.ok) {
        entry.resolve(event.data.payload);
      } else {
        entry.reject(new Error(event.data.error?.message || "导出失败"));
      }
    });
    this.#worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "导出 Worker 加载失败");
      for (const entry of this.#pending.values()) entry.reject(error);
      this.#pending.clear();
    });
  }

  request(action, payload = {}) {
    const id = `export-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, action, payload });
    });
  }
}
