import opencascade from "../vendor/replicad-opencascade.js";
import * as replicad from "../vendor/replicad.mjs";

let kernelPromise;

function serialiseError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

async function initKernel() {
  if (!kernelPromise) {
    kernelPromise = opencascade({
      locateFile: () =>
        new URL("../vendor/replicad_single.wasm", import.meta.url).href,
    }).then((oc) => {
      replicad.setOC(oc);
      return true;
    });
  }
  return kernelPromise;
}

async function runMinimal() {
  await initKernel();
  const shape = replicad.makeBox([0, 0, 0], [10, 20, 30]);
  const volume = replicad.measureVolume(shape);
  const faceCount = shape.faces.length;
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
  const triangleCount = mesh.triangles.length / 3;
  const stlBlob = shape.blobSTL({
    binary: true,
    tolerance: 0.05,
    angularTolerance: 0.1,
  });
  const stl = await stlBlob.arrayBuffer();
  shape.delete();
  return {
    volume,
    faceCount,
    triangleCount,
    stlBytes: stl.byteLength,
    stl,
  };
}

self.addEventListener("message", async (event) => {
  const { id, action } = event.data || {};
  try {
    let payload;
    if (action === "minimal") {
      payload = await runMinimal();
    } else {
      throw new Error(`未知内核操作：${action}`);
    }
    const transfers = payload.stl instanceof ArrayBuffer ? [payload.stl] : [];
    self.postMessage({ id, ok: true, payload }, transfers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: serialiseError(error) });
  }
});
