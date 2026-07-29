const params = new URLSearchParams(window.location.search);
const caseNames = (params.get("cases") || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const state = {
  pass: 0,
  fail: 0,
  skip: 0,
};

let requestId = 0;
let worker;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("../src/geometry-worker.js", { type: "module" });
  worker.addEventListener("message", (event) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) {
      entry.resolve(event.data.payload);
    } else {
      entry.reject(new Error(event.data.error?.message || "内核操作失败"));
    }
  });
  worker.addEventListener("error", (event) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(event.message || "Worker 加载失败"));
    }
    pending.clear();
  });
  return worker;
}

function kernel(action, payload = {}) {
  ensureWorker();
  const id = `case-${++requestId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, payload });
  });
}

function record(label, passed, actual, expected) {
  if (passed) {
    state.pass += 1;
  } else {
    state.fail += 1;
  }
  console.log(
    `ASSERT ${passed ? "PASS" : "FAIL"} ${label} actual=${actual} expected=${expected}`,
  );
}

const assert = {
  equal(actual, expected, label) {
    record(label, Object.is(actual, expected), actual, expected);
  },
  near(actual, expected, tolerance, label) {
    record(
      label,
      Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
      actual,
      `${expected}±${tolerance}`,
    );
  },
  greater(actual, minimum, label) {
    record(label, Number.isFinite(actual) && actual > minimum, actual, `>${minimum}`);
  },
};

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function artifact(name, data) {
  if (typeof window.__selftestEmitArtifact !== "function") {
    throw new Error("判卷器未提供产物写入通道");
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  await window.__selftestEmitArtifact(name, bytesToBase64(bytes));
}

async function run() {
  for (const caseName of caseNames) {
    try {
      const module = await import(`./cases/${caseName}`);
      console.log(`CASE START ${caseName}`);
      await module.default({ assert, kernel, artifact });
      console.log(`CASE END ${caseName}`);
    } catch (error) {
      state.fail += 1;
      console.log(`CASE FAIL ${caseName} ${error?.message || error}`);
    }
  }

  if (worker) worker.terminate();
  const summary = `SELFTEST pass=${state.pass} fail=${state.fail} skip=${state.skip}`;
  document.querySelector("#summary").textContent = summary;
  document.documentElement.dataset.selftestDone = "true";
  console.log(summary);
}

run();
