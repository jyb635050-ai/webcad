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

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label}必须大于 0，当前为 ${value}`);
  }
}

function dispose(object) {
  if (object && typeof object.delete === "function") {
    object.delete();
  }
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

function makePlateTree(params = {}) {
  const width = Number(params.width ?? 100);
  const depth = Number(params.depth ?? 50);
  const thickness = Number(params.thickness ?? 20);
  const holeDiameter = Number(params.holeDiameter ?? 6);
  const filletRadius = Number(params.filletRadius ?? 5);
  const chamferSize = Number(params.chamferSize ?? 0);
  const marginX = Number(params.marginX ?? 10);
  const marginY = Number(params.marginY ?? 10);

  const holes = params.holes ?? [
    [marginX, marginY],
    [width - marginX, marginY],
    [marginX, depth - marginY],
    [width - marginX, depth - marginY],
  ];

  const sketches = {
    plate: {
      id: "plate",
      type: "rectangle",
      origin: [0, 0],
      width,
      height: depth,
    },
  };
  const features = [
    {
      id: "base-extrude",
      type: "extrude",
      name: "拉伸1",
      sketchId: "plate",
      distance: thickness,
    },
  ];
  holes.forEach(([x, y], index) => {
    const sketchId = `hole-${index + 1}`;
    sketches[sketchId] = {
      id: sketchId,
      type: "circle",
      center: [Number(x), Number(y)],
      radius: holeDiameter / 2,
    };
    features.push({
      id: `cut-${index + 1}`,
      type: "cut",
      name: `孔${index + 1}`,
      sketchId,
      throughAll: true,
      distance: thickness,
    });
  });
  if (filletRadius > 0) {
    features.push({
      id: "outer-fillet",
      type: "fillet",
      name: "圆角1",
      radius: filletRadius,
      selection: "outer-vertical",
    });
  }
  if (chamferSize > 0) {
    features.push({
      id: "outer-chamfer",
      type: "chamfer",
      name: "倒角1",
      size: chamferSize,
      selection: "outer-vertical",
    });
  }
  return {
    version: 1,
    unit: "mm",
    sketches,
    features,
  };
}

function makeExtrusion(sketch, distance, zStart = 0) {
  assertPositive(distance, "拉伸距离");
  if (sketch.type === "rectangle") {
    assertPositive(sketch.width, "矩形宽度");
    assertPositive(sketch.height, "矩形高度");
    const [x, y] = sketch.origin ?? [0, 0];
    return replicad.makeBox(
      [x, y, zStart],
      [x + sketch.width, y + sketch.height, zStart + distance],
    );
  }
  if (sketch.type === "circle") {
    assertPositive(sketch.radius, "圆半径");
    const [x, y] = sketch.center ?? [0, 0];
    return replicad.makeCylinder(
      sketch.radius,
      distance,
      [x, y, zStart],
      [0, 0, 1],
    );
  }
  if (sketch.type === "polygon") {
    if (!Array.isArray(sketch.points) || sketch.points.length < 3) {
      throw new RangeError("多边形草图至少需要 3 个点");
    }
    const builder = new replicad.Sketcher("XY", zStart).movePointerTo(
      sketch.points[0],
    );
    sketch.points.slice(1).forEach((point) => builder.lineTo(point));
    return builder.close().extrude(distance);
  }
  throw new Error(`不支持的拉伸草图：${sketch.type}`);
}

function makeRevolution(sketch, feature) {
  if (!Array.isArray(sketch.points) || sketch.points.length < 3) {
    throw new RangeError("旋转草图至少需要 3 个点");
  }
  const builder = new replicad.Sketcher(feature.plane ?? "XZ").movePointerTo(
    sketch.points[0],
  );
  sketch.points.slice(1).forEach((point) => builder.lineTo(point));
  return builder.close().revolve(feature.axis ?? [0, 0, 1], {
    origin: feature.origin ?? [0, 0, 0],
    angle: feature.angle ?? 360,
  });
}

function edgeIsOuterVertical(edge, bounds) {
  const box = edge.boundingBox;
  const [minimum, maximum] = box.bounds;
  dispose(box);
  const epsilon = 1e-5;
  const dx = Math.abs(maximum[0] - minimum[0]);
  const dy = Math.abs(maximum[1] - minimum[1]);
  const dz = Math.abs(maximum[2] - minimum[2]);
  const x = (minimum[0] + maximum[0]) / 2;
  const y = (minimum[1] + maximum[1]) / 2;
  const onOuterX =
    Math.abs(x - bounds.min[0]) <= epsilon ||
    Math.abs(x - bounds.max[0]) <= epsilon;
  const onOuterY =
    Math.abs(y - bounds.min[1]) <= epsilon ||
    Math.abs(y - bounds.max[1]) <= epsilon;
  return dx <= epsilon && dy <= epsilon && dz > epsilon && onOuterX && onOuterY;
}

function meshTopology(vertices, triangles, tolerance = 1e-5) {
  const welded = new Map();
  const remap = new Uint32Array(vertices.length / 3);
  let weldedCount = 0;
  for (let index = 0; index < remap.length; index += 1) {
    const offset = index * 3;
    const key = [
      Math.round(vertices[offset] / tolerance),
      Math.round(vertices[offset + 1] / tolerance),
      Math.round(vertices[offset + 2] / tolerance),
    ].join(":");
    if (!welded.has(key)) {
      welded.set(key, weldedCount);
      weldedCount += 1;
    }
    remap[index] = welded.get(key);
  }

  const edgeUses = new Map();
  let degenerateTriangleCount = 0;
  const addEdge = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
  };
  for (let index = 0; index < triangles.length; index += 3) {
    const a = remap[triangles[index]];
    const b = remap[triangles[index + 1]];
    const c = remap[triangles[index + 2]];
    if (a === b || b === c || c === a) {
      degenerateTriangleCount += 1;
      continue;
    }
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  let nakedEdgeCount = 0;
  let nonManifoldEdgeCount = 0;
  for (const useCount of edgeUses.values()) {
    if (useCount === 1) nakedEdgeCount += 1;
    if (useCount > 2) nonManifoldEdgeCount += 1;
  }
  return {
    weldedVertexCount: weldedCount,
    nakedEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
  };
}

function analyseShape(shape) {
  const volume = replicad.measureVolume(shape);
  const faceCount = shape.faces.length;
  const edgeCount = shape.edges.length;
  const box = shape.boundingBox;
  const [minimum, maximum] = box.bounds;
  dispose(box);
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
  const vertices = new Float64Array(mesh.vertices);
  const normals = new Float32Array(mesh.normals);
  const triangles = new Uint32Array(mesh.triangles);
  const topology = meshTopology(vertices, triangles);
  return {
    volume,
    faceCount,
    edgeCount,
    triangleCount: triangles.length / 3,
    vertexCount: vertices.length / 3,
    bounds: {
      min: [...minimum],
      max: [...maximum],
    },
    ...topology,
    mesh: {
      vertices,
      normals,
      triangles,
      faceGroups: mesh.faceGroups,
    },
  };
}

function replaceShape(current, next) {
  if (current && current !== next) dispose(current);
  return next;
}

async function recomputeFeatureTree(tree) {
  await initKernel();
  let shape = null;
  let baseBounds = null;
  const featureMetrics = [];

  for (const feature of tree.features ?? []) {
    if (feature.enabled === false) continue;
    const sketch = feature.sketchId ? tree.sketches?.[feature.sketchId] : null;
    if (feature.type === "extrude") {
      shape = replaceShape(
        shape,
        makeExtrusion(sketch, Number(feature.distance), Number(feature.zStart ?? 0)),
      );
      const [x, y] = sketch.origin ?? [0, 0];
      baseBounds = {
        min: [x, y, Number(feature.zStart ?? 0)],
        max: [
          x + sketch.width,
          y + sketch.height,
          Number(feature.zStart ?? 0) + Number(feature.distance),
        ],
      };
    } else if (feature.type === "revolve") {
      shape = replaceShape(shape, makeRevolution(sketch, feature));
      const box = shape.boundingBox;
      const [minimum, maximum] = box.bounds;
      baseBounds = { min: [...minimum], max: [...maximum] };
      dispose(box);
    } else if (feature.type === "cut") {
      if (!shape) throw new Error("切除前没有实体");
      const thickness =
        Number(feature.distance) ||
        Math.abs(baseBounds?.max[2] - baseBounds?.min[2]) ||
        1;
      const margin = feature.throughAll ? 1 : 0;
      const tool = makeExtrusion(
        sketch,
        thickness + margin * 2,
        (baseBounds?.min[2] ?? 0) - margin,
      );
      const next = shape.cut(tool);
      dispose(tool);
      shape = replaceShape(shape, next);
    } else if (feature.type === "fillet") {
      if (!shape || !baseBounds) throw new Error("圆角前没有实体");
      const radius = Number(feature.radius);
      assertPositive(radius, "圆角半径");
      const next = shape.fillet((edge) =>
        edgeIsOuterVertical(edge, baseBounds) ? radius : null,
      );
      shape = replaceShape(shape, next);
    } else if (feature.type === "chamfer") {
      if (!shape || !baseBounds) throw new Error("倒角前没有实体");
      const size = Number(feature.size);
      assertPositive(size, "倒角尺寸");
      const next = shape.chamfer((edge) =>
        edgeIsOuterVertical(edge, baseBounds) ? size : null,
      );
      shape = replaceShape(shape, next);
    } else {
      throw new Error(`不支持的特征：${feature.type}`);
    }
    featureMetrics.push({
      id: feature.id,
      type: feature.type,
      volume: replicad.measureVolume(shape),
      faceCount: shape.faces.length,
    });
  }

  if (!shape) throw new Error("特征树没有生成实体");
  const result = {
    tree,
    featureMetrics,
    ...analyseShape(shape),
  };
  dispose(shape);
  return result;
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
  dispose(shape);
  return {
    volume,
    faceCount,
    triangleCount,
    stlBytes: stl.byteLength,
    stl,
  };
}

function collectTransfers(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
    return output;
  }
  if (ArrayBuffer.isView(value)) {
    return collectTransfers(value.buffer, output, seen);
  }
  for (const child of Object.values(value)) {
    collectTransfers(child, output, seen);
  }
  return output;
}

self.addEventListener("message", async (event) => {
  const { id, action, payload = {} } = event.data || {};
  try {
    let result;
    if (action === "minimal") {
      result = await runMinimal();
    } else if (action === "plate") {
      result = await recomputeFeatureTree(makePlateTree(payload.params));
    } else if (action === "recompute") {
      result = await recomputeFeatureTree(payload.tree);
    } else {
      throw new Error(`未知内核操作：${action}`);
    }
    self.postMessage(
      { id, ok: true, payload: result },
      collectTransfers(result),
    );
  } catch (error) {
    self.postMessage({ id, ok: false, error: serialiseError(error) });
  }
});
