const status = document.querySelector("#status");
const details = document.querySelector("#details");
const worker = new Worker("./src/kernel-worker.js", { type: "module" });

const timeout = window.setTimeout(() => {
  status.textContent = "FAIL";
  details.textContent = "OCCT 初始化超过 60 秒";
  document.documentElement.dataset.result = "fail";
  console.error("MINIMAL FAIL timeout=60000");
  worker.terminate();
}, 60_000);

worker.addEventListener(
  "message",
  (event) => {
    window.clearTimeout(timeout);
    const { ok, payload, error } = event.data;
    if (!ok) {
      status.textContent = "FAIL";
      details.textContent = error.message;
      document.documentElement.dataset.result = "fail";
      console.error(`MINIMAL FAIL ${error.message}`);
      return;
    }

    const volumePass = Math.abs(payload.volume - 6000) < 1e-6;
    const stlPass =
      payload.stlBytes === 84 + 50 * payload.triangleCount &&
      payload.stlBytes > 84;
    const passed = volumePass && stlPass && payload.faceCount === 6;
    status.textContent = passed ? "PASS" : "FAIL";
    details.textContent = JSON.stringify(
      {
        volume: payload.volume,
        faceCount: payload.faceCount,
        triangleCount: payload.triangleCount,
        stlBytes: payload.stlBytes,
      },
      null,
      2,
    );
    document.documentElement.dataset.result = passed ? "pass" : "fail";
    console.log(
      `MINIMAL ${passed ? "PASS" : "FAIL"} volume=${payload.volume} faces=${payload.faceCount} triangles=${payload.triangleCount} stlBytes=${payload.stlBytes}`,
    );
  },
  { once: true },
);

worker.postMessage({ id: "minimal-1", action: "minimal" });
