import opencascade from "../vendor/replicad-opencascade.js";
import * as replicad from "../vendor/replicad.mjs";
import { strToU8, zipSync } from "../vendor/fflate.mjs";

let kernelPromise;

function dispose(object) {
  if (object && typeof object.delete === "function") object.delete();
}

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

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label}必须大于 0，当前为 ${value}`);
  }
}

function makeExtrusion(sketch, distance, offset = 0, feature = {}) {
  assertPositive(distance, "拉伸距离");
  const plane = feature.plane ?? sketch.plane ?? "XY";
  const direction = Number(feature.direction ?? 1) < 0 ? -1 : 1;
  const start = direction > 0 ? Number(offset) : Number(offset) - distance;
  if (sketch.type === "rectangle") {
    const [u, v] = sketch.origin ?? [0, 0];
    if (plane === "XY") {
      return replicad.makeBox([u, v, start], [u + sketch.width, v + sketch.height, start + distance]);
    }
    if (plane === "XZ") {
      return replicad.makeBox([u, start, v], [u + sketch.width, start + distance, v + sketch.height]);
    }
    if (plane === "YZ") {
      return replicad.makeBox([start, u, v], [start + distance, u + sketch.width, v + sketch.height]);
    }
  }
  if (sketch.type === "circle") {
    const [u, v] = sketch.center ?? [0, 0];
    if (plane === "XY") return replicad.makeCylinder(sketch.radius, distance, [u, v, start], [0, 0, 1]);
    if (plane === "XZ") return replicad.makeCylinder(sketch.radius, distance, [u, start, v], [0, 1, 0]);
    if (plane === "YZ") return replicad.makeCylinder(sketch.radius, distance, [start, u, v], [1, 0, 0]);
  }
  if (sketch.type === "polygon") {
    const builder = new replicad.Sketcher(plane, Number(offset)).movePointerTo(
      sketch.points[0],
    );
    sketch.points.slice(1).forEach((point) => builder.lineTo(point));
    return builder.close().extrude(distance * direction);
  }
  throw new Error(`不支持的草图类型或平面：${sketch.type}/${plane}`);
}

function makeRevolution(sketch, feature) {
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

function replaceShape(current, next) {
  if (current && current !== next) dispose(current);
  return next;
}

async function buildFeatureTree(tree) {
  await initKernel();
  let shape = null;
  let baseBounds = null;
  for (const feature of tree.features ?? []) {
    if (feature.enabled === false) continue;
    const sketch = feature.sketchId ? tree.sketches?.[feature.sketchId] : null;
    if (feature.type === "extrude") {
      const extrusion = makeExtrusion(
        sketch,
        Number(feature.distance),
        Number(feature.offset ?? feature.zStart ?? 0),
        feature,
      );
      if (shape && feature.operation === "add") {
        const combined = shape.fuse(extrusion);
        dispose(extrusion);
        shape = replaceShape(shape, combined);
      } else {
        shape = replaceShape(shape, extrusion);
      }
      const box = shape.boundingBox;
      const [minimum, maximum] = box.bounds;
      baseBounds = { min: [...minimum], max: [...maximum] };
      dispose(box);
    } else if (feature.type === "revolve") {
      shape = replaceShape(shape, makeRevolution(sketch, feature));
      const box = shape.boundingBox;
      const [minimum, maximum] = box.bounds;
      baseBounds = { min: [...minimum], max: [...maximum] };
      dispose(box);
    } else if (feature.type === "cut") {
      const thickness =
        Number(feature.distance) ||
        Math.abs(baseBounds.max[2] - baseBounds.min[2]);
      const margin = feature.throughAll ? 1 : 0;
      const tool = makeExtrusion(
        sketch,
        thickness + margin * 2,
        baseBounds.min[2] - margin,
      );
      const next = shape.cut(tool);
      dispose(tool);
      shape = replaceShape(shape, next);
    } else if (feature.type === "fillet") {
      const radius = Number(feature.radius);
      const next = shape.fillet((edge) =>
        edgeIsOuterVertical(edge, baseBounds) ? radius : null,
      );
      shape = replaceShape(shape, next);
    } else if (feature.type === "chamfer") {
      const size = Number(feature.size);
      const next = shape.chamfer((edge) =>
        edgeIsOuterVertical(edge, baseBounds) ? size : null,
      );
      shape = replaceShape(shape, next);
    } else {
      throw new Error(`不支持的特征：${feature.type}`);
    }
  }
  if (!shape) throw new Error("特征树没有生成可导出的实体");
  return shape;
}

function meshTopology(vertices, triangles, tolerance = 1e-5) {
  const weldMap = new Map();
  const remap = new Uint32Array(vertices.length / 3);
  let weldedVertexCount = 0;
  for (let index = 0; index < remap.length; index += 1) {
    const offset = index * 3;
    const key = [
      Math.round(vertices[offset] / tolerance),
      Math.round(vertices[offset + 1] / tolerance),
      Math.round(vertices[offset + 2] / tolerance),
    ].join(":");
    if (!weldMap.has(key)) {
      weldMap.set(key, weldedVertexCount);
      weldedVertexCount += 1;
    }
    remap[index] = weldMap.get(key);
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
  for (const uses of edgeUses.values()) {
    if (uses === 1) nakedEdgeCount += 1;
    if (uses > 2) nonManifoldEdgeCount += 1;
  }
  return {
    weldedVertexCount,
    nakedEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
  };
}

function makeObj(vertices, normals, triangles) {
  const lines = ["# 构形 WebCAD OBJ", "# unit: millimeter", "o webcad_part"];
  for (let index = 0; index < vertices.length; index += 3) {
    lines.push(
      `v ${vertices[index]} ${vertices[index + 1]} ${vertices[index + 2]}`,
    );
  }
  const hasNormals = normals.length === vertices.length;
  if (hasNormals) {
    for (let index = 0; index < normals.length; index += 3) {
      lines.push(
        `vn ${normals[index]} ${normals[index + 1]} ${normals[index + 2]}`,
      );
    }
  }
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index] + 1;
    const b = triangles[index + 1] + 1;
    const c = triangles[index + 2] + 1;
    lines.push(hasNormals ? `f ${a}//${a} ${b}//${b} ${c}//${c}` : `f ${a} ${b} ${c}`);
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function make3mf(vertices, triangles) {
  const vertexXml = [];
  for (let index = 0; index < vertices.length; index += 3) {
    vertexXml.push(
      `<vertex x="${vertices[index]}" y="${vertices[index + 1]}" z="${vertices[index + 2]}"/>`,
    );
  }
  const triangleXml = [];
  for (let index = 0; index < triangles.length; index += 3) {
    triangleXml.push(
      `<triangle v1="${triangles[index]}" v2="${triangles[index + 1]}" v3="${triangles[index + 2]}"/>`,
    );
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">构形 WebCAD 模型</metadata>
  <metadata name="Application">构形 WebCAD</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>${vertexXml.join("")}</vertices>
        <triangles>${triangleXml.join("")}</triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(relationships),
      "3D/3dmodel.model": strToU8(model),
    },
    { level: 6 },
  );
}

function estimateWall(tree) {
  const baseFeature = tree.features.find((feature) => feature.type === "extrude");
  const baseSketch = tree.sketches?.[baseFeature?.sketchId];
  if (!baseFeature || baseSketch?.type !== "rectangle") {
    return Number(baseFeature?.distance ?? 0);
  }
  const candidates = [Number(baseFeature.distance)];
  const [originX, originY] = baseSketch.origin ?? [0, 0];
  const maximumX = originX + baseSketch.width;
  const maximumY = originY + baseSketch.height;
  const holes = [];
  for (const feature of tree.features.filter((item) => item.type === "cut")) {
    const sketch = tree.sketches?.[feature.sketchId];
    if (sketch?.type !== "circle") continue;
    const [x, y] = sketch.center;
    candidates.push(
      x - originX - sketch.radius,
      maximumX - x - sketch.radius,
      y - originY - sketch.radius,
      maximumY - y - sketch.radius,
    );
    holes.push(sketch);
  }
  for (let first = 0; first < holes.length; first += 1) {
    for (let second = first + 1; second < holes.length; second += 1) {
      const distance = Math.hypot(
        holes[first].center[0] - holes[second].center[0],
        holes[first].center[1] - holes[second].center[1],
      );
      candidates.push(distance - holes[first].radius - holes[second].radius);
    }
  }
  return Math.max(0, Math.min(...candidates.filter(Number.isFinite)));
}

async function exportAll(tree, options = {}) {
  const shape = await buildFeatureTree(tree);
  const mesh = shape.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
  const vertices = new Float64Array(mesh.vertices);
  const normals = new Float32Array(mesh.normals);
  const triangles = new Uint32Array(mesh.triangles);
  const topology = meshTopology(vertices, triangles);
  const volume = replicad.measureVolume(shape);
  const box = shape.boundingBox;
  const [minimum, maximum] = box.bounds;
  dispose(box);
  const boundsSize = maximum.map((value, index) => value - minimum[index]);
  const bed = options.bed ?? [256, 256, 256];
  const withinBed = boundsSize.every((value, index) => value <= bed[index]);
  const watertight =
    topology.nakedEdgeCount === 0 &&
    topology.nonManifoldEdgeCount === 0 &&
    topology.degenerateTriangleCount === 0;
  const minimumWall = estimateWall(tree);
  const density = Number(options.density ?? 1.24);
  const materialGrams = (volume / 1000) * density;
  const warnings = [];
  if (!watertight) warnings.push("模型不是水密实体");
  if (!withinBed) warnings.push(`模型超出 ${bed.join("×")}mm 打印床`);
  if (minimumWall < 0.8) warnings.push("估算最小壁厚小于 0.8mm");

  const stlBlob = shape.blobSTL({
    binary: true,
    tolerance: 0.05,
    angularTolerance: 0.1,
  });
  const stepBlob = shape.blobSTEP();
  const stl = await stlBlob.arrayBuffer();
  const step = await stepBlob.arrayBuffer();
  const threeMf = make3mf(vertices, triangles);
  const obj = makeObj(vertices, normals, triangles);
  dispose(shape);
  return {
    files: {
      stl,
      "3mf": threeMf,
      step,
      obj,
    },
    fileBytes: {
      stl: stl.byteLength,
      "3mf": threeMf.byteLength,
      step: step.byteLength,
      obj: obj.byteLength,
    },
    triangleCount: triangles.length / 3,
    vertexCount: vertices.length / 3,
    check: {
      ok: warnings.length === 0,
      watertight,
      withinBed,
      minimumWall,
      volume,
      materialGrams,
      boundsSize,
      warnings,
      ...topology,
    },
  };
}

function checkMesh(payload) {
  const vertices = new Float64Array(payload.vertices);
  const triangles = new Uint32Array(payload.triangles);
  const topology = meshTopology(vertices, triangles);
  const warnings = [];
  if (topology.nakedEdgeCount > 0) {
    warnings.push(`检测到 ${topology.nakedEdgeCount} 条开放边`);
  }
  if (topology.nonManifoldEdgeCount > 0) {
    warnings.push(`检测到 ${topology.nonManifoldEdgeCount} 条非流形边`);
  }
  return {
    ok: warnings.length === 0,
    warnings,
    ...topology,
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
    if (action === "exportAll") {
      result = await exportAll(payload.tree, payload.options);
    } else if (action === "checkMesh") {
      result = checkMesh(payload);
    } else {
      throw new Error(`未知导出操作：${action}`);
    }
    self.postMessage(
      { id, ok: true, payload: result },
      collectTransfers(result),
    );
  } catch (error) {
    self.postMessage({ id, ok: false, error: serialiseError(error) });
  }
});
