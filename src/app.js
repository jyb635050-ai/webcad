import { ModelClient } from "./model-client.js";
import { ExportClient } from "./export-client.js";
import { SketchEditor } from "./sketch-editor.js";
import { CadViewer } from "./viewer.js";

const STORAGE_KEY = "gouxing-webcad-project-v1";
const DEFAULT_PARAMS = Object.freeze({
  width: 100,
  depth: 50,
  thickness: 20,
  holeDiameter: 6,
  filletRadius: 5,
  chamferSize: 0,
});

const clone = (value) => structuredClone(value);
const bySelector = (selector) => document.querySelector(selector);
const allBySelector = (selector) => [...document.querySelectorAll(selector)];

class WebCadApp {
  constructor() {
    this.client = new ModelClient();
    this.exporter = new ExportClient();
    this.viewer = new CadViewer(bySelector("#cad-canvas"));
    this.state = {
      params: clone(DEFAULT_PARAMS),
      mode: "empty",
      holes: [],
      result: null,
      history: [],
      future: [],
      dirty: false,
    };
    this.dimensionTarget = null;
    this.recomputeTimer = 0;
    this.sketch = new SketchEditor(bySelector("#sketch-overlay"), {
      onChange: (entities) => this.onSketchChange(entities),
      onDimension: (payload) => this.openDimension(payload),
    });
    this.bindUi();
    this.syncParameterInputs();
    this.tryRestore();
    document.documentElement.dataset.appReady = "true";
    document.documentElement.dataset.triangleCount = "0";
    window.__webcadQA = {
      sampleCanvas: (columns = 20, rows = 10) =>
        this.viewer.sampleColors(columns, rows),
      getState: () => ({
        mode: this.state.mode,
        params: clone(this.state.params),
        triangleCount: this.state.result?.triangleCount ?? 0,
        featureCount: this.state.result?.featureMetrics?.length ?? 0,
      }),
    };
  }

  bindUi() {
    allBySelector("[data-tool]").forEach((button) => {
      button.addEventListener("click", () =>
        this.sketch.setTool(button.dataset.tool),
      );
    });
    allBySelector("[data-feature]").forEach((button) => {
      button.addEventListener("click", () =>
        this.applyFeature(button.dataset.feature),
      );
    });
    allBySelector("[data-action]").forEach((button) => {
      button.addEventListener("click", () =>
        this.handleAction(button.dataset.action),
      );
    });
    allBySelector("[data-param]").forEach((input) => {
      input.addEventListener("change", () => this.parameterChanged(input));
    });
    allBySelector("[data-export]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        this.requestExport(button.dataset.export);
      });
    });
    allBySelector("[data-camera]").forEach((button) => {
      button.addEventListener("click", () =>
        this.cameraAction(button.dataset.camera),
      );
    });

    const projectFile = bySelector("#project-file");
    projectFile.addEventListener("change", async () => {
      const [file] = projectFile.files;
      if (file) await this.importProject(file);
      projectFile.value = "";
    });

    const dimensionDialog = bySelector("#dimension-dialog");
    dimensionDialog.addEventListener("close", () => {
      if (
        dimensionDialog.returnValue === "confirm" &&
        this.dimensionTarget
      ) {
        const value = Number(bySelector("#dimension-value").value);
        this.pushHistory();
        this.sketch.updateDimension(
          this.dimensionTarget.entity.id,
          this.dimensionTarget.dimension,
          value,
        );
      }
      this.dimensionTarget = null;
    });

    window.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      const shortcuts = {
        l: "line",
        r: "rectangle",
        c: "circle",
        d: "dimension",
      };
      if (shortcuts[event.key.toLowerCase()]) {
        this.sketch.setTool(shortcuts[event.key.toLowerCase()]);
      }
      if (event.key.toLowerCase() === "e") this.applyFeature("extrude");
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        this.saveProject();
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        this.undo();
      }
    });
  }

  handleAction(action) {
    const handlers = {
      new: () => this.newProject(),
      example: () => this.loadExample(),
      save: () => this.saveProject(),
      "project-export": () => this.exportProject(),
      "project-import": () => bySelector("#project-file").click(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      "open-export": () => bySelector("#export-dialog").showModal(),
      "print-check": () => this.runPrintCheck(),
      "close-toast": () => {
        bySelector("#toast").hidden = true;
      },
      fullscreen: () => this.toggleFullscreen(),
    };
    handlers[action]?.();
  }

  cameraAction(action) {
    if (action === "fit" || action === "isometric") this.viewer.fitView();
    if (action === "zoom-in") this.viewer.zoom(0.82);
    if (action === "zoom-out") this.viewer.zoom(1.22);
  }

  onSketchChange(entities) {
    this.state.dirty = true;
    const rectangleCount = entities.filter(
      (entity) => entity.type === "rectangle",
    ).length;
    const circleCount = entities.filter(
      (entity) => entity.type === "circle",
    ).length;
    this.setStatus(`草图：${rectangleCount} 个矩形，${circleCount} 个圆`);
  }

  openDimension(payload) {
    this.dimensionTarget = payload;
    bySelector("#dimension-label").textContent = payload.label;
    bySelector("#dimension-value").value = payload.value.toFixed(2);
    bySelector("#dimension-dialog").showModal();
    bySelector("#dimension-value").select();
  }

  applyFeature(feature) {
    const handlers = {
      extrude: () => this.extrudeSketch(),
      cut: () => this.cutSketchCircles(),
      fillet: () => this.setFillet(),
      chamfer: () => this.setChamfer(),
      revolve: () => this.revolveSketch(),
    };
    handlers[feature]?.();
  }

  extrudeSketch() {
    const rectangle = this.sketch.getRectangle();
    const dimensions = this.sketch.rectangleDimensions(rectangle);
    if (!dimensions) {
      this.showToast("缺少闭合轮廓", "先用矩形工具画一个轮廓。", true);
      return;
    }
    this.pushHistory();
    this.state.params.width = Number(dimensions.width.toFixed(3));
    this.state.params.depth = Number(dimensions.depth.toFixed(3));
    this.state.params.filletRadius = 0;
    this.state.params.chamferSize = 0;
    this.state.holes = [];
    this.state.mode = "plate";
    this.syncParameterInputs();
    this.sketch.setTool(null);
    this.recomputePlate("拉伸草图");
  }

  cutSketchCircles() {
    const rectangle = this.sketch.getRectangle();
    const dimensions = this.sketch.rectangleDimensions(rectangle);
    const circles = this.sketch.getCircles();
    if (!dimensions || circles.length === 0) {
      this.showToast("没有可切除的圆", "在矩形内部画一个或多个圆后再切除。", true);
      return;
    }
    this.pushHistory();
    this.state.holes = circles.map((circle) => [
      (circle.center.x - dimensions.origin.x) * this.sketch.mmPerPixel,
      (circle.center.y - dimensions.origin.y) * this.sketch.mmPerPixel,
    ]);
    this.state.params.holeDiameter = Number(
      (circles[0].radius * 2 * this.sketch.mmPerPixel).toFixed(3),
    );
    this.syncParameterInputs();
    this.sketch.setTool(null);
    this.recomputePlate("切除圆孔");
  }

  setFillet() {
    if (!this.state.result) {
      this.showToast("没有实体", "先拉伸草图，再添加圆角。", true);
      return;
    }
    this.pushHistory();
    this.state.params.chamferSize = 0;
    this.state.params.filletRadius = Math.max(
      0.5,
      Number(this.state.params.filletRadius) || 5,
    );
    this.syncParameterInputs();
    this.recomputePlate("添加圆角");
  }

  setChamfer() {
    if (!this.state.result) {
      this.showToast("没有实体", "先拉伸草图，再添加倒角。", true);
      return;
    }
    this.pushHistory();
    this.state.params.filletRadius = 0;
    this.state.params.chamferSize = 2;
    this.syncParameterInputs();
    this.recomputePlate("添加倒角");
  }

  async revolveSketch() {
    const rectangle = this.sketch.getRectangle();
    const dimensions = this.sketch.rectangleDimensions(rectangle);
    if (!dimensions) {
      this.showToast("缺少旋转轮廓", "先画矩形作为旋转截面。", true);
      return;
    }
    const radialWidth = Math.min(Math.max(dimensions.width, 2), 40);
    const height = Math.min(Math.max(dimensions.depth, 2), 100);
    const innerRadius = 10;
    const tree = {
      version: 1,
      unit: "mm",
      sketches: {
        profile: {
          id: "profile",
          type: "polygon",
          points: [
            [innerRadius, 0],
            [innerRadius + radialWidth, 0],
            [innerRadius + radialWidth, height],
            [innerRadius, height],
          ],
        },
      },
      features: [
        {
          id: "revolve-1",
          type: "revolve",
          name: "旋转1",
          sketchId: "profile",
          plane: "XZ",
          axis: [0, 0, 1],
          angle: 360,
        },
      ],
    };
    this.pushHistory();
    this.state.mode = "revolve";
    await this.recomputeTree(tree, "旋转草图");
  }

  parameterChanged(input) {
    const key = input.dataset.param;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    this.pushHistory();
    this.state.params[key] = value;
    this.state.dirty = true;
    if (!this.state.result || this.state.mode !== "plate") return;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = window.setTimeout(
      () => this.recomputePlate(`修改${key}`),
      160,
    );
  }

  platePayload() {
    const params = clone(this.state.params);
    if (params.holeDiameter <= 0 || Array.isArray(this.state.holes)) {
      params.holes = params.holeDiameter <= 0 ? [] : clone(this.state.holes);
    }
    return params;
  }

  async recomputePlate(reason) {
    return this.runKernel(
      () => this.client.request("plate", { params: this.platePayload() }),
      reason,
    );
  }

  async recomputeTree(tree, reason) {
    return this.runKernel(
      () => this.client.request("recompute", { tree }),
      reason,
    );
  }

  async runKernel(operation, reason) {
    bySelector("#loading-state").hidden = false;
    this.setStatus(`${reason}：正在重算…`);
    try {
      const result = await operation();
      this.applyResult(result);
      this.state.dirty = true;
      this.setStatus(
        `${reason}完成 · ${result.triangleCount.toLocaleString()} 个三角形`,
      );
      return result;
    } catch (error) {
      this.showToast("几何重算失败", error.message, true);
      this.setStatus(`重算失败：${error.message}`);
      return null;
    } finally {
      bySelector("#loading-state").hidden = true;
    }
  }

  applyResult(result) {
    this.state.result = result;
    this.viewer.setMesh(result.mesh, result.bounds);
    bySelector("#empty-state").hidden = true;
    document.documentElement.dataset.triangleCount = String(
      result.triangleCount,
    );
    document.documentElement.dataset.modelReady = "true";
    this.renderFeatureTree();
    this.renderMetrics();
  }

  renderFeatureTree() {
    const tree = bySelector("#feature-tree");
    tree.replaceChildren();
    const features = this.state.result?.featureMetrics ?? [];
    for (const [index, feature] of features.entries()) {
      const item = document.createElement("li");
      if (index === features.length - 1) item.classList.add("active");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      const iconNames = {
        extrude: "extrude",
        cut: "cut",
        fillet: "fillet",
        chamfer: "chamfer",
        revolve: "revolve",
      };
      use.setAttribute("href", `#icon-${iconNames[feature.type] || "cube"}`);
      icon.append(use);
      const label = document.createElement("span");
      const names = {
        extrude: "拉伸",
        cut: "切除",
        fillet: "圆角",
        chamfer: "倒角",
        revolve: "旋转",
      };
      label.textContent = `${names[feature.type] || feature.type}${index + 1}`;
      const metric = document.createElement("span");
      metric.className = "tree-metric";
      metric.textContent = `${feature.faceCount}面`;
      item.append(icon, label, metric);
      tree.append(item);
    }
  }

  renderMetrics() {
    const result = this.state.result;
    if (!result) return;
    bySelector("#metric-open").textContent = String(result.nakedEdgeCount);
    bySelector("#metric-nonmanifold").textContent = String(
      result.nonManifoldEdgeCount,
    );
    bySelector("#metric-volume").textContent =
      `${result.volume.toFixed(2)} mm³`;
    const wall = Math.min(
      Number(this.state.params.thickness) || Infinity,
      Math.max(Number(this.state.params.filletRadius) || 0, 1.2),
    );
    bySelector("#metric-wall").textContent = `${wall.toFixed(2)} mm`;
    const watertight =
      result.nakedEdgeCount === 0 && result.nonManifoldEdgeCount === 0;
    const waterMetric = bySelector("#metric-watertight");
    waterMetric.textContent = watertight ? "通过" : "失败";
    waterMetric.className = watertight ? "pass" : "fail";
  }

  runPrintCheck() {
    if (!this.state.result) {
      this.showToast("没有可检查的模型", "先创建实体。", true);
      return false;
    }
    const result = this.state.result;
    const size = result.bounds.max.map(
      (value, index) => value - result.bounds.min[index],
    );
    const watertight =
      result.nakedEdgeCount === 0 && result.nonManifoldEdgeCount === 0;
    const withinBed = size.every((value) => value <= 256);
    const passed = watertight && withinBed;
    const status = bySelector("#check-status");
    status.textContent = passed ? "通过" : "需处理";
    status.className = `check-state ${passed ? "pass" : "fail"}`;
    this.showToast(
      passed ? "打印自检通过" : "打印自检发现问题",
      passed
        ? `模型水密，包围盒 ${size.map((value) => value.toFixed(1)).join("×")} mm。`
        : "请检查开放边、非流形边或打印床尺寸。",
      !passed,
    );
    return passed;
  }

  async requestExport(format) {
    if (!this.state.result) {
      this.showToast("没有可导出的模型", "先创建一个实体。", true);
      return;
    }
    bySelector("#loading-state").hidden = false;
    this.setStatus(`正在生成 ${format.toUpperCase()}…`);
    try {
      const exported = await this.exporter.request("exportAll", {
        tree: this.state.result.tree,
        options: { bed: [256, 256, 256], density: 1.24 },
      });
      const check = exported.check;
      bySelector("#metric-wall").textContent =
        `${check.minimumWall.toFixed(2)} mm`;
      bySelector("#metric-volume").textContent =
        `${check.volume.toFixed(2)} mm³`;
      const status = bySelector("#check-status");
      status.textContent = check.ok ? "通过" : "需处理";
      status.className = `check-state ${check.ok ? "pass" : "fail"}`;
      if (!check.ok) {
        this.showToast("导出前自检未通过", check.warnings.join("；"), true);
        return;
      }
      const file = exported.files[format];
      const mimeTypes = {
        stl: "model/stl",
        "3mf": "model/3mf",
        step: "application/step",
        obj: "model/obj",
      };
      const blob = new Blob([file], {
        type: mimeTypes[format] || "application/octet-stream",
      });
      this.downloadBlob(blob, `gouxing-model.${format}`);
      if (bySelector("#export-dialog").open) bySelector("#export-dialog").close();
      this.showToast(
        "导出成功",
        `${format.toUpperCase()} · ${exported.fileBytes[format].toLocaleString()} 字节 · 预估 ${check.materialGrams.toFixed(1)}g PLA`,
      );
      this.setStatus(`${format.toUpperCase()} 导出成功`);
    } catch (error) {
      this.showToast("导出失败", error.message, true);
      this.setStatus(`导出失败：${error.message}`);
    } finally {
      bySelector("#loading-state").hidden = true;
    }
  }

  loadExample() {
    this.pushHistory();
    this.state.params = clone(DEFAULT_PARAMS);
    this.state.mode = "plate";
    this.state.holes = null;
    this.sketch.setEntities([
      {
        id: "example-plate",
        type: "rectangle",
        start: { x: 190, y: 150 },
        end: { x: 590, y: 350 },
      },
      ...[
        [230, 190],
        [550, 190],
        [230, 310],
        [550, 310],
      ].map(([x, y], index) => ({
        id: `example-hole-${index + 1}`,
        type: "circle",
        center: { x, y },
        start: { x, y },
        end: { x: x + 12, y },
        radius: 12,
      })),
    ]);
    this.syncParameterInputs();
    this.sketch.setTool(null);
    this.recomputePlate("载入四孔板");
  }

  newProject() {
    this.pushHistory();
    this.state.params = clone(DEFAULT_PARAMS);
    this.state.mode = "empty";
    this.state.holes = [];
    this.state.result = null;
    this.state.dirty = false;
    this.sketch.clear();
    this.sketch.setTool(null);
    this.viewer.clearModel();
    bySelector("#empty-state").hidden = false;
    bySelector("#feature-tree").innerHTML =
      '<li class="tree-empty">等待草图</li>';
    document.documentElement.dataset.triangleCount = "0";
    delete document.documentElement.dataset.modelReady;
    this.syncParameterInputs();
    this.resetMetrics();
    this.setStatus("新工程已创建");
  }

  resetMetrics() {
    for (const selector of [
      "#metric-open",
      "#metric-nonmanifold",
      "#metric-wall",
      "#metric-volume",
      "#metric-watertight",
    ]) {
      bySelector(selector).textContent = "—";
      bySelector(selector).className = "";
    }
    const status = bySelector("#check-status");
    status.textContent = "待检查";
    status.className = "check-state neutral";
  }

  projectData() {
    return {
      schema: "gouxing-webcad-project",
      version: 1,
      savedAt: new Date().toISOString(),
      mode: this.state.mode,
      params: clone(this.state.params),
      holes: clone(this.state.holes),
      sketches: clone(this.sketch.entities),
    };
  }

  saveProject() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projectData()));
    this.state.dirty = false;
    this.showToast("工程已保存", "模型和草图已保存到当前浏览器。");
  }

  exportProject() {
    const blob = new Blob([JSON.stringify(this.projectData(), null, 2)], {
      type: "application/json",
    });
    this.downloadBlob(blob, "gouxing-webcad-project.json");
    this.showToast("工程 JSON 已导出", "可在另一台电脑继续编辑。");
  }

  async importProject(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.schema !== "gouxing-webcad-project" || data.version !== 1) {
        throw new Error("不是受支持的构形 WebCAD 工程文件");
      }
      this.pushHistory();
      await this.restoreData(data);
      this.showToast("工程已导入", file.name);
    } catch (error) {
      this.showToast("导入失败", error.message, true);
    }
  }

  tryRestore() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      this.restoreData(JSON.parse(saved));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  async restoreData(data) {
    this.state.params = { ...clone(DEFAULT_PARAMS), ...clone(data.params) };
    this.state.mode = data.mode ?? "empty";
    this.state.holes = clone(data.holes ?? []);
    this.sketch.setEntities(data.sketches ?? []);
    this.syncParameterInputs();
    if (this.state.mode === "plate") {
      await this.recomputePlate("恢复工程");
    } else if (this.state.mode === "empty") {
      this.newProject();
    }
  }

  snapshot() {
    return {
      mode: this.state.mode,
      params: clone(this.state.params),
      holes: clone(this.state.holes),
      sketches: clone(this.sketch.entities),
    };
  }

  pushHistory() {
    this.state.history.push(this.snapshot());
    if (this.state.history.length > 30) this.state.history.shift();
    this.state.future = [];
  }

  async applySnapshot(snapshot) {
    this.state.mode = snapshot.mode;
    this.state.params = clone(snapshot.params);
    this.state.holes = clone(snapshot.holes);
    this.sketch.setEntities(snapshot.sketches);
    this.syncParameterInputs();
    if (this.state.mode === "plate") await this.recomputePlate("历史重算");
    if (this.state.mode === "empty") this.newProject();
  }

  undo() {
    const snapshot = this.state.history.pop();
    if (!snapshot) return;
    this.state.future.push(this.snapshot());
    this.applySnapshot(snapshot);
  }

  redo() {
    const snapshot = this.state.future.pop();
    if (!snapshot) return;
    this.state.history.push(this.snapshot());
    this.applySnapshot(snapshot);
  }

  syncParameterInputs() {
    allBySelector("[data-param]").forEach((input) => {
      input.value = this.state.params[input.dataset.param] ?? 0;
    });
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      bySelector(".app-shell").requestFullscreen();
    }
  }

  setStatus(message) {
    bySelector("#status-message").textContent = message;
  }

  showToast(title, message, isError = false) {
    const toast = bySelector("#toast");
    toast.classList.toggle("error", isError);
    bySelector("#toast-title").textContent = title;
    bySelector("#toast-message").textContent = message;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 5200);
  }
}

new WebCadApp();
