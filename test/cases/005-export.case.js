function createExportClient() {
  const worker = new Worker(
    new URL("../../src/export-worker.js", import.meta.url),
    { type: "module" },
  );
  let nextId = 0;
  const pending = new Map();
  worker.addEventListener("message", (event) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) {
      entry.resolve(event.data.payload);
    } else {
      entry.reject(new Error(event.data.error?.message || "导出失败"));
    }
  });
  return {
    request(action, payload) {
      const id = `export-case-${++nextId}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, action, payload });
      });
    },
    close() {
      worker.terminate();
    },
  };
}

export default async function exportCase({ assert, kernel, artifact }) {
  const model = await kernel("plate", {
    params: {
      width: 100,
      depth: 50,
      thickness: 20,
      holeDiameter: 6,
      filletRadius: 5,
    },
  });
  const exporter = createExportClient();
  const result = await exporter.request("exportAll", {
    tree: model.tree,
    options: {
      bed: [256, 256, 256],
      density: 1.24,
    },
  });

  await artifact("plate.stl", new Uint8Array(result.files.stl));
  await artifact("plate.3mf", result.files["3mf"]);
  await artifact("plate.step", new Uint8Array(result.files.step));
  await artifact("plate.obj", result.files.obj);

  assert.equal(
    result.fileBytes.stl,
    84 + 50 * result.triangleCount,
    "二进制STL长度公式",
  );
  assert.greater(result.fileBytes["3mf"], 1000, "真ZIP 3MF字节数");
  assert.greater(result.fileBytes.step, 1000, "STEP字节数");
  assert.greater(result.fileBytes.obj, 1000, "OBJ字节数");
  assert.equal(result.check.nakedEdgeCount, 0, "导出网格开放边数");
  assert.equal(Number(result.check.watertight), 1, "打印自检水密");
  assert.equal(Number(result.check.withinBed), 1, "打印床尺寸检查");
  assert.near(result.check.minimumWall, 7, 0.001, "估算最小壁厚");
  assert.greater(result.check.materialGrams, 100, "PLA预估克数");

  const openMesh = await exporter.request("checkMesh", {
    vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0],
    triangles: [0, 1, 2],
  });
  assert.equal(openMesh.nakedEdgeCount, 3, "非水密模型报警开放边数");
  assert.greater(openMesh.warnings.length, 0, "非水密模型报警条数");
  exporter.close();
}
