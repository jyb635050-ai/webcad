import { ModelClient } from "./model-client.js";
import { ExportClient } from "./export-client.js";
import { SketchEditor } from "./sketch-editor.js";
import { CadViewer } from "./viewer.js";

const STORAGE_KEY = "gouxing-webcad-project-v2";
const DEFAULT_PARAMS = Object.freeze({
  width: 100,
  depth: 50,
  thickness: 20,
  holeDiameter: 6,
  filletRadius: 0,
  chamferSize: 0,
});

const clone = (value) => structuredClone(value);
const bySelector = (selector) => document.querySelector(selector);
const allBySelector = (selector) => [...document.querySelectorAll(selector)];
const emptyTree = () => ({ version: 2, unit: "mm", sketches: {}, features: [] });

class WebCadApp {
  constructor() {
    this.client = new ModelClient();
    this.exporter = new ExportClient();
    this.state = {
      params: clone(DEFAULT_PARAMS),
      mode: "select-plane",
      selection: null,
      tree: emptyTree(),
      result: null,
      pendingProfile: null,
      pendingExtrude: 20,
      pendingCutProfiles: [],
      pendingCut: 10,
      cutThroughAll: false,
      history: [],
      future: [],
      dirty: false,
    };
    this.viewer = new CadViewer(bySelector("#cad-canvas"), {
      onSelection: (selection) => this.onSelection(selection),
      onExtrudeDrag: (distance) => this.updateFeaturePreview(distance),
    });
    this.dimensionTarget = null;
    this.recomputeTimer = 0;
    this.sketch = new SketchEditor(bySelector("#sketch-overlay"), {
      onChange: (entities) => this.onSketchChange(entities),
      onDimension: (payload) => this.openDimension(payload),
    });
    this.bindUi();
    this.syncParameterInputs();
    this.newProject(false);
    document.documentElement.dataset.appReady = "true";
    window.__webcadQA = {
      sampleCanvas: (columns = 20, rows = 10) =>
        this.viewer.sampleColors(columns, rows),
      getDatumScreenPoint: (plane = "XY") =>
        this.viewer.getDatumScreenPoint(plane),
      getGizmoScreenPoint: () => this.viewer.getGizmoScreenPoint(),
      getSketchAttachment: () => this.getSketchAttachment(),
      getTopFaceScreenPoint: (u = 0.5, v = 0.5) => {
        const bounds = this.state.result?.bounds;
        if (!bounds) return null;
        return this.viewer.projectPoint([
          bounds.min[0] + (bounds.max[0] - bounds.min[0]) * u,
          bounds.min[1] + (bounds.max[1] - bounds.min[1]) * v,
          bounds.max[2],
        ]);
      },
      selectDatumPlane: (plane = "XY") => this.viewer.selectDatumPlane(plane),
      getState: () => ({
        mode: this.state.mode,
        workflowStage: this.state.mode,
        selection: clone(this.state.selection),
        params: clone(this.state.params),
        pendingExtrude: this.state.pendingExtrude,
        pendingCut: this.state.pendingCut,
        cutThroughAll: this.state.cutThroughAll,
        triangleCount: this.state.result?.triangleCount ?? 0,
        featureCount: this.state.result?.featureMetrics?.length ?? 0,
        featureTypes: this.state.tree.features.map((feature) => feature.type),
        volume: this.state.result?.volume ?? 0,
        nakedEdgeCount: this.state.result?.nakedEdgeCount ?? 0,
        bounds: clone(this.state.result?.bounds ?? null),
      }),
    };
  }

  bindUi() {
    allBySelector("[data-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        if (this.state.mode !== "sketch") {
          this.showToast("先进入草图", "选择一个面，然后点击“草图”。", true);
          return;
        }
        this.sketch.setTool(button.dataset.tool);
      });
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
    allBySelector("[data-plane]").forEach((element) => {
      element.addEventListener("click", () =>
        this.viewer.selectDatumPlane(element.dataset.plane),
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

    const extrudeDistance = bySelector("#extrude-distance");
    extrudeDistance.addEventListener("input", () => {
      this.updateExtrudePreview(Number(extrudeDistance.value));
    });
    extrudeDistance.addEventListener("change", () => {
      this.updateExtrudePreview(Number(extrudeDistance.value));
    });

    const cutDistance = bySelector("#cut-distance");
    cutDistance.addEventListener("input", () => {
      this.updateCutPreview(Number(cutDistance.value));
    });
    cutDistance.addEventListener("change", () => {
      this.updateCutPreview(Number(cutDistance.value));
    });
    const cutThroughAll = bySelector("#cut-through-all");
    cutThroughAll.addEventListener("change", () => {
      this.state.cutThroughAll = cutThroughAll.checked;
      cutDistance.disabled = cutThroughAll.checked;
      bySelector("#cut-mode-help").textContent = cutThroughAll.checked
        ? "贯穿所选方向上的整个实体。"
        : "红色预览指向实体内部；可拖动箭头或输入精确深度。";
      if (this.state.mode === "cut-preview") this.renderCutPreview();
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
      const shortcuts = { l: "line", r: "rectangle", c: "circle", d: "dimension" };
      const tool = shortcuts[event.key.toLowerCase()];
      if (tool && this.state.mode === "sketch") this.sketch.setTool(tool);
      if (event.key.toLowerCase() === "e") this.applyFeature("extrude");
      if (event.key === "Escape") {
        if (this.state.mode === "extrude-preview") this.cancelExtrude();
        else if (this.state.mode === "cut-preview") this.cancelCut();
        else if (this.state.mode === "sketch") this.cancelSketch();
      }
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
      save: () => this.saveProject(),
      "project-export": () => this.exportProject(),
      "project-import": () => bySelector("#project-file").click(),
      "select-plane": () => this.selectPlaneAction(),
      "start-sketch": () => this.startSketch(),
      "finish-sketch": () => this.finishSketch(),
      "cancel-sketch": () => this.cancelSketch(),
      "cancel-extrude": () => this.cancelExtrude(),
      "confirm-extrude": () => this.confirmExtrude(),
      "cancel-cut": () => this.cancelCut(),
      "confirm-cut": () => this.confirmCut(),
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

  onSelection(selection) {
    if (!["select-plane", "face-selected"].includes(this.state.mode)) return;
    this.state.selection = clone(selection);
    bySelector("#selection-type").textContent =
      selection.kind === "face" ? "实体面" : "基准面";
    bySelector("#selection-name").textContent = selection.label;
    bySelector("#selection-status").textContent = `选择：${selection.label}`;
    bySelector("#empty-state").hidden = true;
    this.setWorkflowStage("face-selected");
    this.setStatus(`已选择 ${selection.label}，点击“草图”`);
    this.renderFeatureTree();
  }

  selectPlaneAction() {
    if (["extrude-preview", "cut-preview"].includes(this.state.mode)) {
      this.viewer.clearExtrudePreview();
    }
    this.viewer.exitSketchMode({ restoreReferences: !this.state.result });
    this.sketch.setTool(null);
    this.sketch.clear();
    this.state.pendingProfile = null;
    this.state.selection = null;
    this.viewer.clearSelection();
    this.viewer.setSelectionMode(true);
    this.viewer.showReferencePlanes(!this.state.result);
    bySelector("#selection-type").textContent = "未选择";
    bySelector("#selection-name").textContent = "—";
    bySelector("#selection-status").textContent = "选择：0";
    this.setWorkflowStage("select-plane");
    if (!this.state.result) bySelector("#empty-state").hidden = false;
    this.setStatus(
      this.state.result ? "点击实体面开始新草图" : "点击三维基准面开始",
    );
  }

  startSketch() {
    if (!this.state.selection) {
      this.showToast("还没有选择面", "先点选基准面或实体面。", true);
      return;
    }
    this.pushHistory();
    this.sketch.clear();
    this.viewer.setSelectionMode(false);
    this.viewer.enterSketchMode(this.state.selection);
    this.setWorkflowStage("sketch");
    this.sketch.setTool("rectangle");
    this.setStatus(`正在 ${this.state.selection.label} 上绘制草图`);
    this.renderFeatureTree(true);
  }

  finishSketch() {
    if (this.state.mode !== "sketch") return;
    const hasRectangle = Boolean(
      this.sketch.rectangleDimensions(this.sketch.getRectangle()),
    );
    const hasCircles = this.sketch.getCircles().length > 0;
    if (!hasRectangle && !hasCircles) {
      this.showToast("草图未闭合", "先画一个矩形或圆形闭合轮廓。", true);
      return;
    }
    this.sketch.setTool(null);
    this.setWorkflowStage("sketch-ready");
    this.setStatus(
      this.state.result
        ? "草图已完成，可选择拉伸或切除"
        : "草图已完成，点击“拉伸”",
    );
    this.renderFeatureTree(true);
  }

  cancelSketch() {
    this.sketch.setTool(null);
    this.sketch.clear();
    this.viewer.exitSketchMode({ restoreReferences: !this.state.result });
    this.viewer.setSelectionMode(true);
    if (this.state.result) this.viewer.fitView();
    this.setWorkflowStage(this.state.selection ? "face-selected" : "select-plane");
    this.setStatus("草图已取消");
    this.renderFeatureTree();
  }

  onSketchChange(entities) {
    this.state.dirty = true;
    const rectangleCount = entities.filter((entity) => entity.type === "rectangle").length;
    const circleCount = entities.filter((entity) => entity.type === "circle").length;
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
      extrude: () => this.beginExtrude(),
      cut: () => this.beginCut(),
      fillet: () => this.addEdgeFeature("fillet"),
      chamfer: () => this.addEdgeFeature("chamfer"),
      revolve: () => this.revolveSketch(),
    };
    handlers[feature]?.();
  }

  facePlaneRanges(selection = this.state.selection) {
    const bounds = this.state.result?.bounds;
    if (!selection || selection.kind !== "face" || !bounds) return null;
    if (selection.plane === "XY") {
      return [[bounds.min[0], bounds.max[0]], [bounds.min[1], bounds.max[1]]];
    }
    if (selection.plane === "XZ") {
      return [[bounds.min[0], bounds.max[0]], [bounds.min[2], bounds.max[2]]];
    }
    return [[bounds.min[1], bounds.max[1]], [bounds.min[2], bounds.max[2]]];
  }

  clampProfileToFace(profile, selection = this.state.selection) {
    const ranges = this.facePlaneRanges(selection);
    if (!ranges) return profile;
    const next = clone(profile);
    if (next.type === "circle") {
      next.center[0] = Math.min(
        ranges[0][1] - next.radius,
        Math.max(ranges[0][0] + next.radius, next.center[0]),
      );
      next.center[1] = Math.min(
        ranges[1][1] - next.radius,
        Math.max(ranges[1][0] + next.radius, next.center[1]),
      );
      return next;
    }
    next.origin[0] = Math.min(
      ranges[0][1] - next.width,
      Math.max(ranges[0][0], next.origin[0]),
    );
    next.origin[1] = Math.min(
      ranges[1][1] - next.height,
      Math.max(ranges[1][0], next.origin[1]),
    );
    return next;
  }

  buildPendingProfile() {
    const rectangle = this.sketch.getRectangle();
    if (!rectangle || !this.state.selection) return null;
    const start = this.viewer.screenPointToSketch(rectangle.start);
    const end = this.viewer.screenPointToSketch(rectangle.end);
    if (!start || !end) return null;
    const width = Math.abs(end[0] - start[0]);
    const height = Math.abs(end[1] - start[1]);
    if (width <= 0 || height <= 0) return null;
    const selection = this.state.selection;
    return this.clampProfileToFace({
      type: "rectangle",
      plane: selection.plane,
      origin: [
        Number(Math.min(start[0], end[0]).toFixed(3)),
        Number(Math.min(start[1], end[1]).toFixed(3)),
      ],
      width: Number(width.toFixed(3)),
      height: Number(height.toFixed(3)),
      offset: Number(selection.coordinate ?? 0),
      direction: Number(selection.direction ?? 1),
      normal: clone(selection.normal),
    });
  }

  buildPendingCutProfiles() {
    const selection = this.state.selection;
    if (!selection || selection.kind !== "face") return [];
    const inwardNormal = selection.normal.map((value) => -Number(value));
    const circles = this.sketch.getCircles();
    if (circles.length) {
      return circles.map((circle) => {
        const center = this.viewer.screenPointToSketch(circle.center);
        const edge = this.viewer.screenPointToSketch({
          x: circle.center.x + circle.radius,
          y: circle.center.y,
        });
        if (!center || !edge) return null;
        const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
        return this.clampProfileToFace({
          type: "circle",
          plane: selection.plane,
          center: center.map((value) => Number(value.toFixed(3))),
          radius: Number(radius.toFixed(3)),
          offset: Number(selection.coordinate),
          direction: -Number(selection.direction ?? 1),
          normal: inwardNormal,
        });
      }).filter(Boolean);
    }
    const rectangle = this.buildPendingProfile();
    if (!rectangle) return [];
    return [{
      ...rectangle,
      direction: -Number(selection.direction ?? 1),
      normal: inwardNormal,
    }];
  }

  getSketchAttachment() {
    const camera = this.viewer.getSketchCameraState();
    const rectangle = this.sketch.getRectangle();
    const profile = rectangle ? this.buildPendingProfile() : null;
    if (!profile || !rectangle) return { ...camera, maxScreenError: null };
    const bounds = bySelector("#sketch-overlay").getBoundingClientRect();
    const overlayPoints = [
      rectangle.start,
      rectangle.end,
      { x: rectangle.start.x, y: rectangle.end.y },
      { x: rectangle.end.x, y: rectangle.start.y },
    ].map((point) => ({ x: bounds.left + point.x, y: bounds.top + point.y }));
    const projected = this.viewer.getProfileScreenPoints(profile);
    const errors = projected.map((point) =>
      Math.min(
        ...overlayPoints.map((candidate) =>
          Math.hypot(point.x - candidate.x, point.y - candidate.y),
        ),
      ),
    );
    return {
      ...camera,
      profile: clone(profile),
      maxScreenError: Math.max(...errors),
    };
  }

  beginExtrude() {
    if (this.state.mode === "sketch") {
      this.showToast("先完成草图", "点击“完成草图”后才能拉伸。", true);
      return;
    }
    if (this.state.mode !== "sketch-ready") {
      this.showToast("没有可拉伸的草图", "选择面、进入草图并完成闭合轮廓。", true);
      return;
    }
    const profile = this.buildPendingProfile();
    if (!profile) {
      this.showToast("缺少闭合轮廓", "先画一个矩形并完成草图。", true);
      return;
    }
    this.state.pendingProfile = profile;
    this.state.pendingExtrude = Number(this.state.params.thickness) || 20;
    bySelector("#extrude-distance").value = String(this.state.pendingExtrude);
    bySelector("#extrude-gizmo-label").textContent = `${this.state.pendingExtrude} mm`;
    this.viewer.exitSketchMode();
    this.viewer.fitView();
    this.viewer.showExtrudePreview(profile, this.state.pendingExtrude);
    this.setWorkflowStage("extrude-preview");
    this.setStatus("拖动蓝色箭头，或输入拉伸长度");
  }

  updateFeaturePreview(value) {
    if (this.state.mode === "cut-preview") this.updateCutPreview(value);
    else this.updateExtrudePreview(value);
  }

  updateExtrudePreview(value) {
    if (this.state.mode !== "extrude-preview") return;
    const distance = Number(value);
    if (!Number.isFinite(distance) || distance <= 0) return;
    this.state.pendingExtrude = Math.round(distance * 10) / 10;
    bySelector("#extrude-distance").value = String(this.state.pendingExtrude);
    bySelector("#extrude-gizmo-label").textContent = `${this.state.pendingExtrude} mm`;
    this.viewer.showExtrudePreview(
      this.state.pendingProfile,
      this.state.pendingExtrude,
    );
  }

  cancelExtrude() {
    if (this.state.mode !== "extrude-preview") return;
    this.viewer.clearExtrudePreview();
    this.state.pendingProfile = null;
    this.viewer.enterSketchMode(this.state.selection);
    this.setWorkflowStage("sketch-ready");
    this.setStatus("拉伸已取消，草图仍贴在原平面上");
  }

  async confirmExtrude() {
    if (this.state.mode !== "extrude-preview" || !this.state.pendingProfile) return;
    const profile = clone(this.state.pendingProfile);
    const tree = clone(this.state.tree);
    const featureNumber = tree.features.filter((feature) => feature.type === "extrude").length + 1;
    const sketchId = `sketch-${Object.keys(tree.sketches).length + 1}`;
    tree.sketches[sketchId] = {
      id: sketchId,
      type: "rectangle",
      plane: profile.plane,
      origin: clone(profile.origin),
      width: profile.width,
      height: profile.height,
    };
    tree.features.push({
      id: `extrude-${featureNumber}`,
      type: "extrude",
      name: `拉伸${featureNumber}`,
      sketchId,
      plane: profile.plane,
      distance: this.state.pendingExtrude,
      offset: profile.offset,
      direction: profile.direction,
      operation: tree.features.length === 0 ? "base" : "add",
    });

    this.pushHistory();
    this.viewer.clearExtrudePreview();
    const result = await this.recomputeTree(tree, `拉伸${featureNumber}`);
    if (!result) {
      this.viewer.showExtrudePreview(profile, this.state.pendingExtrude);
      return;
    }
    if (featureNumber === 1) {
      this.state.params.width = profile.width;
      this.state.params.depth = profile.height;
    }
    this.state.params.thickness = this.state.pendingExtrude;
    this.state.pendingProfile = null;
    this.state.selection = null;
    this.sketch.clear();
    this.sketch.setTool(null);
    this.viewer.setSelectionMode(true);
    this.setWorkflowStage("select-plane");
    this.syncParameterInputs();
    this.setStatus(`拉伸${featureNumber}完成；可继续选择实体面`);
  }

  selectedAxisSpan() {
    const bounds = this.state.result?.bounds;
    const plane = this.state.selection?.plane;
    if (!bounds || !plane) return 1;
    const axis = plane === "XY" ? 2 : plane === "XZ" ? 1 : 0;
    return Math.abs(bounds.max[axis] - bounds.min[axis]);
  }

  cutPreviewDistance() {
    return this.state.cutThroughAll
      ? this.selectedAxisSpan() + 2
      : this.state.pendingCut;
  }

  beginCut() {
    if (this.state.mode === "sketch") {
      this.showToast("先完成草图", "点击“完成草图”后才能切除。", true);
      return;
    }
    if (
      this.state.mode !== "sketch-ready" ||
      !this.state.result ||
      this.state.selection?.kind !== "face"
    ) {
      this.showToast("没有可切除的面上草图", "先选择实体面，绘制闭合草图并完成草图。", true);
      return;
    }
    const profiles = this.buildPendingCutProfiles();
    if (!profiles.length) {
      this.showToast("缺少闭合轮廓", "请绘制一个矩形或至少一个圆。", true);
      return;
    }
    this.state.pendingCutProfiles = profiles;
    this.state.pendingCut = Math.min(10, Math.max(this.selectedAxisSpan() / 2, 0.1));
    this.state.cutThroughAll = false;
    bySelector("#cut-distance").value = String(this.state.pendingCut);
    bySelector("#cut-distance").disabled = false;
    bySelector("#cut-through-all").checked = false;
    bySelector("#cut-mode-help").textContent =
      "红色预览指向实体内部；可拖动箭头或输入精确深度。";
    this.viewer.exitSketchMode();
    this.viewer.fitView();
    this.renderCutPreview();
    this.setWorkflowStage("cut-preview");
    this.setStatus("设置切除深度，或选择“贯穿全部”");
  }

  renderCutPreview() {
    if (!this.state.pendingCutProfiles.length) return;
    const distance = this.cutPreviewDistance();
    this.viewer.showCutPreview(this.state.pendingCutProfiles, distance);
    bySelector("#extrude-gizmo-label").textContent = this.state.cutThroughAll
      ? "贯穿全部"
      : `${this.state.pendingCut} mm`;
  }

  updateCutPreview(value) {
    if (this.state.mode !== "cut-preview" || this.state.cutThroughAll) return;
    const distance = Number(value);
    if (!Number.isFinite(distance) || distance <= 0) return;
    this.state.pendingCut = Math.round(distance * 10) / 10;
    bySelector("#cut-distance").value = String(this.state.pendingCut);
    this.renderCutPreview();
  }

  cancelCut() {
    if (this.state.mode !== "cut-preview") return;
    this.viewer.clearExtrudePreview();
    this.state.pendingCutProfiles = [];
    this.viewer.enterSketchMode(this.state.selection);
    this.setWorkflowStage("sketch-ready");
    this.setStatus("切除已取消，草图仍贴在原实体面上");
  }

  async confirmCut() {
    if (
      this.state.mode !== "cut-preview" ||
      !this.state.pendingCutProfiles.length
    ) return;
    const tree = clone(this.state.tree);
    let cutNumber = tree.features.filter((feature) => feature.type === "cut").length;
    for (const profile of this.state.pendingCutProfiles) {
      cutNumber += 1;
      const sketchId = `sketch-${Object.keys(tree.sketches).length + 1}`;
      tree.sketches[sketchId] = profile.type === "circle"
        ? {
            id: sketchId,
            type: "circle",
            plane: profile.plane,
            center: clone(profile.center),
            radius: profile.radius,
          }
        : {
            id: sketchId,
            type: "rectangle",
            plane: profile.plane,
            origin: clone(profile.origin),
            width: profile.width,
            height: profile.height,
          };
      tree.features.push({
        id: `cut-${cutNumber}`,
        type: "cut",
        name: `切除${cutNumber}`,
        sketchId,
        plane: profile.plane,
        distance: this.state.pendingCut,
        throughAll: this.state.cutThroughAll,
        offset: profile.offset,
        direction: profile.direction,
      });
    }

    this.pushHistory();
    this.viewer.clearExtrudePreview();
    const result = await this.recomputeTree(
      tree,
      this.state.cutThroughAll ? "贯穿切除" : `切除 ${this.state.pendingCut}mm`,
    );
    if (!result) {
      this.renderCutPreview();
      return;
    }
    const completedCuts = this.state.pendingCutProfiles.length;
    this.state.pendingCutProfiles = [];
    this.state.selection = null;
    this.sketch.clear();
    this.sketch.setTool(null);
    this.viewer.setSelectionMode(true);
    this.setWorkflowStage("select-plane");
    this.setStatus(`切除完成（${completedCuts} 个轮廓）；可继续选择实体面`);
  }

  async addEdgeFeature(type) {
    if (!this.state.result) {
      this.showToast("没有实体", `先拉伸实体，再添加${type === "fillet" ? "圆角" : "倒角"}。`, true);
      return;
    }
    const tree = clone(this.state.tree);
    const isFillet = type === "fillet";
    const size = isFillet ? 5 : 2;
    tree.features.push({
      id: `${type}-${tree.features.length + 1}`,
      type,
      name: `${isFillet ? "圆角" : "倒角"}1`,
      [isFillet ? "radius" : "size"]: size,
      selection: "outer-vertical",
    });
    this.pushHistory();
    await this.recomputeTree(tree, isFillet ? "添加圆角" : "添加倒角");
  }

  async revolveSketch() {
    const dimensions = this.sketch.rectangleDimensions();
    if (this.state.mode !== "sketch-ready" || !dimensions) {
      this.showToast("没有可旋转的草图", "选择基准面、绘制矩形并完成草图。", true);
      return;
    }
    const innerRadius = 10;
    const tree = emptyTree();
    tree.sketches.profile = {
      id: "profile",
      type: "polygon",
      points: [
        [innerRadius, 0],
        [innerRadius + dimensions.width, 0],
        [innerRadius + dimensions.width, dimensions.depth],
        [innerRadius, dimensions.depth],
      ],
    };
    tree.features.push({
      id: "revolve-1",
      type: "revolve",
      name: "旋转1",
      sketchId: "profile",
      plane: "XZ",
      axis: [0, 0, 1],
      angle: 360,
    });
    this.pushHistory();
    const result = await this.recomputeTree(tree, "旋转草图");
    if (result) {
      this.sketch.clear();
      this.state.selection = null;
      this.setWorkflowStage("select-plane");
    }
  }

  parameterChanged(input) {
    const key = input.dataset.param;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return;
    this.pushHistory();
    this.state.params[key] = value;
    this.state.dirty = true;
    const tree = clone(this.state.tree);
    const firstExtrude = tree.features.find((feature) => feature.type === "extrude");
    const firstSketch = firstExtrude ? tree.sketches[firstExtrude.sketchId] : null;
    if (!firstExtrude || !firstSketch) return;
    if (key === "width") firstSketch.width = value;
    if (key === "depth") firstSketch.height = value;
    if (key === "thickness") firstExtrude.distance = value;
    if (!["width", "depth", "thickness"].includes(key)) return;
    clearTimeout(this.recomputeTimer);
    this.recomputeTimer = window.setTimeout(
      () => this.recomputeTree(tree, `修改${key}`),
      160,
    );
  }

  platePayload() {
    return { ...clone(this.state.params), holes: [] };
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
      this.setStatus(`${reason}完成 · ${result.triangleCount.toLocaleString()} 个三角形`);
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
    this.state.tree = clone(result.tree);
    this.viewer.setMesh(result.mesh, result.bounds);
    bySelector("#empty-state").hidden = true;
    bySelector("#model-parameters").hidden = false;
    document.documentElement.dataset.triangleCount = String(result.triangleCount);
    document.documentElement.dataset.modelReady = "true";
    this.renderFeatureTree();
    this.renderMetrics();
  }

  renderFeatureTree(includePendingSketch = false) {
    const treeElement = bySelector("#feature-tree");
    treeElement.replaceChildren();
    const planes = [
      ["YZ", "前视基准面"],
      ["XY", "上视基准面"],
      ["XZ", "右视基准面"],
    ];
    for (const [plane, label] of planes) {
      const item = document.createElement("li");
      item.className = "tree-plane";
      item.dataset.plane = plane;
      if (this.state.selection?.plane === plane && this.state.selection.kind === "datum-plane") {
        item.classList.add("active");
      }
      item.innerHTML = `<svg><use href="#icon-plane"></use></svg><span>${label}</span>`;
      item.addEventListener("click", () => this.viewer.selectDatumPlane(plane));
      treeElement.append(item);
    }

    const metrics = new Map(
      (this.state.result?.featureMetrics ?? []).map((metric) => [metric.id, metric]),
    );
    const shownSketches = new Set();
    for (const [index, feature] of this.state.tree.features.entries()) {
      if (feature.sketchId && !shownSketches.has(feature.sketchId)) {
        shownSketches.add(feature.sketchId);
        const sketchItem = document.createElement("li");
        sketchItem.innerHTML = `<svg><use href="#icon-sketch"></use></svg><span>草图${shownSketches.size}</span>`;
        treeElement.append(sketchItem);
      }
      const item = document.createElement("li");
      if (index === this.state.tree.features.length - 1 && !includePendingSketch) item.classList.add("active");
      const names = { extrude: "拉伸", cut: "切除", fillet: "圆角", chamfer: "倒角", revolve: "旋转" };
      const icons = { extrude: "extrude", cut: "cut", fillet: "fillet", chamfer: "chamfer", revolve: "revolve" };
      const metric = metrics.get(feature.id);
      item.innerHTML = `<svg><use href="#icon-${icons[feature.type] || "cube"}"></use></svg><span>${feature.name || `${names[feature.type] || feature.type}${index + 1}`}</span><span class="tree-metric">${metric ? `${metric.faceCount}面` : ""}</span>`;
      treeElement.append(item);
    }
    if (includePendingSketch) {
      const item = document.createElement("li");
      item.className = "active";
      item.innerHTML = `<svg><use href="#icon-sketch"></use></svg><span>草图${shownSketches.size + 1}</span><span class="tree-metric">编辑中</span>`;
      treeElement.append(item);
    }
  }

  renderMetrics() {
    const result = this.state.result;
    if (!result) return;
    bySelector("#metric-open").textContent = String(result.nakedEdgeCount);
    bySelector("#metric-nonmanifold").textContent = String(result.nonManifoldEdgeCount);
    bySelector("#metric-volume").textContent = `${result.volume.toFixed(2)} mm³`;
    const wall = Math.min(
      Number(this.state.params.thickness) || Infinity,
      Math.max(Number(this.state.params.filletRadius) || 0, 1.2),
    );
    bySelector("#metric-wall").textContent = `${wall.toFixed(2)} mm`;
    const watertight = result.nakedEdgeCount === 0 && result.nonManifoldEdgeCount === 0;
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
    const size = result.bounds.max.map((value, index) => value - result.bounds.min[index]);
    const watertight = result.nakedEdgeCount === 0 && result.nonManifoldEdgeCount === 0;
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
        tree: this.state.tree,
        options: { bed: [256, 256, 256], density: 1.24 },
      });
      const check = exported.check;
      bySelector("#metric-wall").textContent = `${check.minimumWall.toFixed(2)} mm`;
      bySelector("#metric-volume").textContent = `${check.volume.toFixed(2)} mm³`;
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

  newProject(push = true) {
    if (push) this.pushHistory();
    this.state.params = clone(DEFAULT_PARAMS);
    this.state.mode = "select-plane";
    this.state.selection = null;
    this.state.tree = emptyTree();
    this.state.result = null;
    this.state.pendingProfile = null;
    this.state.pendingExtrude = 20;
    this.state.pendingCutProfiles = [];
    this.state.pendingCut = 10;
    this.state.cutThroughAll = false;
    this.state.dirty = false;
    this.sketch.clear();
    this.sketch.setTool(null);
    this.viewer.exitSketchMode({ restoreReferences: true });
    this.viewer.clearExtrudePreview();
    this.viewer.clearSelection();
    this.viewer.clearModel();
    this.viewer.showReferencePlanes(true);
    this.viewer.setSelectionMode(true);
    bySelector("#empty-state").hidden = false;
    bySelector("#model-parameters").hidden = true;
    bySelector("#selection-type").textContent = "未选择";
    bySelector("#selection-name").textContent = "—";
    document.documentElement.dataset.triangleCount = "0";
    delete document.documentElement.dataset.modelReady;
    this.syncParameterInputs();
    this.resetMetrics();
    this.renderFeatureTree();
    this.setWorkflowStage("select-plane");
    this.setStatus("新工程：请选择一个基准面");
  }

  setWorkflowStage(stage) {
    this.state.mode = stage;
    document.documentElement.dataset.workflowStage = stage;
    const activeStage = stage === "face-selected"
      ? "select-plane"
      : stage === "cut-preview"
        ? "sketch-ready"
        : stage;
    const order = ["select-plane", "sketch", "sketch-ready", "extrude-preview"];
    const activeIndex = order.indexOf(activeStage);
    allBySelector("[data-stage]").forEach((button) => {
      const index = order.indexOf(button.dataset.stage);
      button.classList.toggle("active", index === activeIndex);
      button.classList.toggle("complete", index >= 0 && index < activeIndex);
    });
    const canStartSketch = Boolean(this.state.selection) && ["select-plane", "face-selected"].includes(stage);
    allBySelector('[data-action="start-sketch"]').forEach((button) => {
      button.disabled = !canStartSketch;
    });
    allBySelector('[data-action="finish-sketch"]').forEach((button) => {
      button.disabled = stage !== "sketch";
    });
    allBySelector('[data-feature="extrude"]').forEach((button) => {
      button.disabled =
        stage !== "sketch-ready" || !this.sketch.getRectangle();
    });
    allBySelector('[data-feature="cut"]').forEach((button) => {
      button.disabled = !(
        stage === "sketch-ready" &&
        this.state.result &&
        this.state.selection?.kind === "face" &&
        (this.sketch.getRectangle() || this.sketch.getCircles().length)
      );
    });
    allBySelector("[data-tool]").forEach((button) => {
      button.disabled = stage !== "sketch";
    });
    bySelector("#selection-inspector").hidden = !["select-plane", "face-selected"].includes(stage);
    bySelector("#sketch-inspector").hidden = !["sketch", "sketch-ready"].includes(stage);
    bySelector("#extrude-inspector").hidden = stage !== "extrude-preview";
    bySelector("#cut-inspector").hidden = stage !== "cut-preview";
    bySelector("#extrude-gizmo-label").hidden =
      !["extrude-preview", "cut-preview"].includes(stage);
    const showModelTools =
      Boolean(this.state.result) &&
      ["select-plane", "face-selected"].includes(stage);
    bySelector("#model-parameters").hidden = !showModelTools;
    bySelector(".print-check").hidden = !showModelTools;
    bySelector(".export-panel").hidden = !showModelTools;
    const hints = {
      "select-plane": this.state.result ? "选择实体面" : "选择基准面",
      "face-selected": "点击“草图”",
      sketch: "在所选平面上绘制闭合草图",
      "sketch-ready": this.state.result ? "选择“拉伸”或“切除”" : "点击“拉伸”",
      "extrude-preview": "拖动箭头或输入数值",
      "cut-preview": "设置深度或贯穿全部",
    };
    bySelector("#workflow-hint").textContent = hints[stage] || "";
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
      version: 2,
      savedAt: new Date().toISOString(),
      params: clone(this.state.params),
      tree: clone(this.state.tree),
    };
  }

  saveProject() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projectData()));
    this.state.dirty = false;
    this.showToast("工程已保存", "特征树已保存到当前浏览器；新开页面仍从空白工程开始。 ");
  }

  exportProject() {
    const blob = new Blob([JSON.stringify(this.projectData(), null, 2)], {
      type: "application/json",
    });
    this.downloadBlob(blob, "gouxing-webcad-project.json");
    this.showToast("工程 JSON 已导出", "可在另一台电脑继续编辑。 ");
  }

  async importProject(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.schema !== "gouxing-webcad-project" || ![1, 2].includes(data.version)) {
        throw new Error("不是受支持的构形 WebCAD 工程文件");
      }
      this.pushHistory();
      await this.restoreData(data);
      this.showToast("工程已导入", file.name);
    } catch (error) {
      this.showToast("导入失败", error.message, true);
    }
  }

  async restoreData(data) {
    this.state.params = { ...clone(DEFAULT_PARAMS), ...clone(data.params ?? {}) };
    this.syncParameterInputs();
    if (data.tree?.features?.length) {
      const result = await this.recomputeTree(data.tree, "恢复工程");
      if (result) {
        this.state.selection = null;
        this.setWorkflowStage("select-plane");
      }
    } else if (data.version === 1 && data.mode === "plate") {
      await this.recomputePlate("恢复旧版工程");
      this.setWorkflowStage("select-plane");
    } else {
      this.newProject(false);
    }
  }

  snapshot() {
    return {
      params: clone(this.state.params),
      tree: clone(this.state.tree),
    };
  }

  pushHistory() {
    this.state.history.push(this.snapshot());
    if (this.state.history.length > 30) this.state.history.shift();
    this.state.future = [];
  }

  async applySnapshot(snapshot) {
    this.state.params = clone(snapshot.params);
    this.syncParameterInputs();
    if (snapshot.tree?.features?.length) {
      await this.recomputeTree(snapshot.tree, "历史重算");
      this.state.selection = null;
      this.setWorkflowStage("select-plane");
    } else {
      this.newProject(false);
    }
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
    if (document.fullscreenElement) document.exitFullscreen();
    else bySelector(".app-shell").requestFullscreen();
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