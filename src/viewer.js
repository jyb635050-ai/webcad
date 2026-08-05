import * as THREE from "../vendor/three.module.js";

const QA_FLAT_COLOR_MODE = false;
const CLEAR_COLOR = 0xfbfcfe;
const BLUE = 0x1769e0;

function disposeObject(object) {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) {
      child.material.forEach((material) => material.dispose?.());
    } else {
      child.material?.dispose?.();
    }
  });
}

export class CadViewer {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(CLEAR_COLOR);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !QA_FLAT_COLOR_MODE;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.modelGroup = new THREE.Group();
    this.referenceGroup = new THREE.Group();
    this.selectionGroup = new THREE.Group();
    this.sketchPlaneGroup = new THREE.Group();
    this.previewGroup = new THREE.Group();
    this.scene.add(
      this.referenceGroup,
      this.modelGroup,
      this.selectionGroup,
      this.sketchPlaneGroup,
      this.previewGroup,
    );

    this.target = new THREE.Vector3(50, 25, 10);
    this.distance = 180;
    this.yaw = -0.75;
    this.pitch = 0.58;
    this.dragging = false;
    this.gizmoDragging = false;
    this.selectionMode = true;
    this.lastPointer = { x: 0, y: 0 };
    this.pointerStart = { x: 0, y: 0 };
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.currentBounds = null;
    this.currentSelection = null;
    this.sketchSelection = null;
    this.sketchMode = false;
    this.gizmoPickMesh = null;
    this.gizmoDragStart = null;

    this.addEnvironment();
    this.createReferencePlanes();
    this.bindControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.fitView();
    this.animate();
  }

  setCallbacks(callbacks = {}) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  addEnvironment() {
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0xb9c5d3, 2.2);
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(-90, -120, 220);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const fill = new THREE.DirectionalLight(0xc8ddff, 1.1);
    fill.position.set(140, 40, 80);
    this.scene.add(hemisphere, key, fill);

    const grid = new THREE.GridHelper(500, 50, 0xb9c6d6, 0xe3e8ef);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.02;
    grid.material.transparent = true;
    grid.material.opacity = 0.62;
    grid.visible = !QA_FLAT_COLOR_MODE;
    grid.name = "reference-grid";
    this.scene.add(grid);

    const axes = new THREE.AxesHelper(28);
    axes.position.set(-18, -18, 0.05);
    axes.visible = !QA_FLAT_COLOR_MODE;
    axes.name = "axes";
    this.scene.add(axes);
  }

  createReferencePlanes() {
    const definitions = [
      {
        plane: "XY",
        label: "上视基准面",
        size: [112, 76],
        position: [50, 25, 0],
        rotation: [0, 0, 0],
        normal: [0, 0, 1],
      },
      {
        plane: "XZ",
        label: "右视基准面",
        size: [112, 70],
        position: [50, 0, 35],
        rotation: [Math.PI / 2, 0, 0],
        normal: [0, 1, 0],
      },
      {
        plane: "YZ",
        label: "前视基准面",
        size: [76, 70],
        position: [0, 25, 35],
        rotation: [0, Math.PI / 2, 0],
        normal: [1, 0, 0],
      },
    ];

    for (const definition of definitions) {
      const geometry = new THREE.PlaneGeometry(...definition.size);
      const material = new THREE.MeshBasicMaterial({
        color: BLUE,
        transparent: true,
        opacity: 0.075,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const plane = new THREE.Mesh(geometry, material);
      plane.position.set(...definition.position);
      plane.rotation.set(...definition.rotation);
      plane.userData = {
        kind: "datum-plane",
        plane: definition.plane,
        label: definition.label,
        normal: definition.normal,
        coordinate: 0,
        direction: 1,
      };
      plane.name = `datum-${definition.plane}`;

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineDashedMaterial({
          color: BLUE,
          transparent: true,
          opacity: 0.56,
          dashSize: 5,
          gapSize: 3,
        }),
      );
      outline.computeLineDistances();
      outline.name = `datum-outline-${definition.plane}`;
      plane.add(outline);
      this.referenceGroup.add(plane);
    }
  }

  showReferencePlanes(visible = true) {
    this.referenceGroup.visible = visible;
  }

  selectionPlaneCenter(selection = this.currentSelection) {
    if (!selection) return new THREE.Vector3();
    if (selection.kind === "face" && this.currentBounds) {
      const center = this.currentBounds.min.map(
        (value, index) => (value + this.currentBounds.max[index]) / 2,
      );
      const axis = selection.plane === "XY" ? 2 : selection.plane === "XZ" ? 1 : 0;
      center[axis] = Number(selection.coordinate ?? center[axis]);
      return new THREE.Vector3(...center);
    }
    const datum = this.referenceGroup.getObjectByName(`datum-${selection.plane}`);
    return datum
      ? datum.position.clone()
      : new THREE.Vector3(...(selection.point ?? [0, 0, 0]));
  }

  clearSketchPlane() {
    for (const child of [...this.sketchPlaneGroup.children]) {
      disposeObject(child);
      this.sketchPlaneGroup.remove(child);
    }
  }

  createSketchPlaneVisual(selection) {
    this.clearSketchPlane();
    const width = Math.max(this.canvas.parentElement.clientWidth * 0.25, 80);
    const height = Math.max(this.canvas.parentElement.clientHeight * 0.25, 60);
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: 0x7aaef4,
        transparent: true,
        opacity: selection.kind === "face" ? 0.065 : 0.105,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    surface.name = "active-sketch-plane";

    const vertices = [];
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    for (let u = -Math.floor(halfWidth / 10) * 10; u <= halfWidth; u += 10) {
      vertices.push(u, -halfHeight, 0.015, u, halfHeight, 0.015);
    }
    for (let v = -Math.floor(halfHeight / 10) * 10; v <= halfHeight; v += 10) {
      vertices.push(-halfWidth, v, 0.015, halfWidth, v, 0.015);
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );
    const grid = new THREE.LineSegments(
      gridGeometry,
      new THREE.LineBasicMaterial({
        color: BLUE,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    grid.name = "active-sketch-grid";

    const group = new THREE.Group();
    group.add(surface, grid);
    if (selection.plane === "XZ") group.rotation.x = Math.PI / 2;
    if (selection.plane === "YZ") group.rotation.y = Math.PI / 2;
    const center = this.selectionPlaneCenter(selection);
    const normal = new THREE.Vector3(...selection.normal).normalize();
    group.position.copy(center).addScaledVector(normal, 0.025);
    group.name = "active-sketch-surface";
    this.sketchPlaneGroup.add(group);
  }

  enterSketchMode(selection = this.currentSelection) {
    if (!selection) return;
    this.sketchMode = true;
    this.sketchSelection = structuredClone(selection);
    this.canvas.parentElement.classList.add("sketching");
    for (const plane of this.referenceGroup.children) plane.visible = false;
    this.referenceGroup.visible = false;
    this.selectionGroup.visible = selection.kind === "face";
    this.createSketchPlaneVisual(selection);
    this.alignToPlane(selection.plane);
  }

  exitSketchMode({ restoreReferences = false } = {}) {
    this.sketchMode = false;
    this.sketchSelection = null;
    this.canvas.parentElement.classList.remove("sketching");
    this.clearSketchPlane();
    for (const plane of this.referenceGroup.children) plane.visible = true;
    this.referenceGroup.visible = restoreReferences;
    this.selectionGroup.visible = true;
    this.camera.up.set(0, 0, 1);
  }

  screenPointToSketch(point, selection = this.sketchSelection ?? this.currentSelection) {
    if (!selection) return null;
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = (Number(point.x) / bounds.width) * 2 - 1;
    this.pointer.y = -(Number(point.y) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const normal = new THREE.Vector3(...selection.normal).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      normal,
      this.selectionPlaneCenter(selection),
    );
    const world = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, world)) return null;
    if (selection.plane === "XY") return [world.x, world.y];
    if (selection.plane === "XZ") return [world.x, world.z];
    return [world.y, world.z];
  }

  sketchPointToWorld(point, profile) {
    const [u, v] = point;
    const offset = Number(profile.offset ?? 0);
    if (profile.plane === "XY") return [u, v, offset];
    if (profile.plane === "XZ") return [u, offset, v];
    return [offset, u, v];
  }

  getProfileScreenPoints(profile) {
    let points = [];
    if (profile.type === "circle") {
      const [u, v] = profile.center;
      points = [
        [u - profile.radius, v],
        [u + profile.radius, v],
        [u, v - profile.radius],
        [u, v + profile.radius],
      ];
    } else if (profile.type === "polygon") {
      points = profile.points;
    } else {
      const [u, v] = profile.origin;
      points = [
        [u, v],
        [u + profile.width, v],
        [u, v + profile.height],
        [u + profile.width, v + profile.height],
      ];
    }
    return points.map((point) =>
      this.projectPoint(this.sketchPointToWorld(point, profile)),
    );
  }

  getSketchCameraState() {
    const selection = this.sketchSelection;
    if (!selection) {
      return { active: false, planeVisible: false, cameraNormalDot: 0 };
    }
    const viewDirection = new THREE.Vector3();
    this.camera.getWorldDirection(viewDirection);
    const normal = new THREE.Vector3(...selection.normal).normalize();
    return {
      active: this.sketchMode,
      plane: selection.plane,
      coordinate: Number(selection.coordinate ?? 0),
      planeVisible:
        this.sketchPlaneGroup.visible && this.sketchPlaneGroup.children.length > 0,
      cameraNormalDot: Math.abs(viewDirection.dot(normal)),
      datumVisible:
        selection.kind !== "datum-plane" ||
        Boolean(
          this.sketchPlaneGroup.visible &&
            this.sketchPlaneGroup.getObjectByName("active-sketch-plane"),
        ),
    };
  }

  setSelectionMode(enabled) {
    this.selectionMode = Boolean(enabled);
    this.canvas.classList.toggle("selection-mode", this.selectionMode);
  }

  bindControls() {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.pointerStart = { x: event.clientX, y: event.clientY };
      this.lastPointer = { ...this.pointerStart };

      if (event.button === 0 && this.hitGizmo(event)) {
        this.gizmoDragging = true;
        this.gizmoDragStart = {
          y: event.clientY,
          distance: Number(this.previewDistance) || 20,
        };
      } else {
        this.dragging = true;
      }
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (this.gizmoDragging && this.gizmoDragStart) {
        const delta = (this.gizmoDragStart.y - event.clientY) * 0.25;
        const distance = Math.max(
          0.1,
          Math.round((this.gizmoDragStart.distance + delta) * 10) / 10,
        );
        this.callbacks.onExtrudeDrag?.(distance);
        return;
      }
      if (!this.dragging) return;
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + dy * 0.004,
        -0.15,
        1.42,
      );
      this.updateCamera();
    });

    this.canvas.addEventListener("pointerup", (event) => {
      const moved = Math.hypot(
        event.clientX - this.pointerStart.x,
        event.clientY - this.pointerStart.y,
      );
      const wasGizmo = this.gizmoDragging;
      this.dragging = false;
      this.gizmoDragging = false;
      this.gizmoDragStart = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (!wasGizmo && moved < 4 && event.button === 0 && this.selectionMode) {
        this.pickSelection(event);
      }
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.distance = THREE.MathUtils.clamp(
          this.distance * Math.exp(event.deltaY * 0.001),
          8,
          2200,
        );
        this.updateCamera();
      },
      { passive: false },
    );
  }

  setRayFromEvent(event) {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  hitGizmo(event) {
    if (!this.gizmoPickMesh) return false;
    this.setRayFromEvent(event);
    return this.raycaster.intersectObject(this.gizmoPickMesh, false).length > 0;
  }

  pickSelection(event) {
    this.setRayFromEvent(event);
    const datumMeshes = this.referenceGroup.visible
      ? this.referenceGroup.children.filter((child) => child.isMesh)
      : [];
    const datumHit = this.raycaster.intersectObjects(datumMeshes, false)[0];
    if (datumHit) {
      this.selectDatumPlane(datumHit.object.userData.plane);
      return;
    }

    const solid = this.modelGroup.getObjectByName("cad-solid");
    if (!solid || !this.currentBounds) return;
    const hit = this.raycaster.intersectObject(solid, false)[0];
    if (!hit?.face) return;
    const minimum = this.currentBounds.min;
    const maximum = this.currentBounds.max;
    const faceNormal = hit.face.normal
      .clone()
      .transformDirection(solid.matrixWorld)
      .normalize();
    const normalComponents = faceNormal.toArray().map((value) => Math.abs(value));
    const axis = normalComponents.indexOf(Math.max(...normalComponents));
    const direction = faceNormal.getComponent(axis) >= 0 ? 1 : -1;
    const plane = axis === 2 ? "XY" : axis === 1 ? "XZ" : "YZ";
    const labels = ["实体右侧面", "实体后侧面", "实体顶面"];
    const reverseLabels = ["实体左侧面", "实体前侧面", "实体底面"];
    const normal = [0, 0, 0];
    normal[axis] = direction;
    const coordinate = direction > 0 ? maximum[axis] : minimum[axis];
    this.applySelection({
      kind: "face",
      plane,
      label: direction > 0 ? labels[axis] : reverseLabels[axis],
      normal,
      coordinate,
      direction,
      point: hit.point.toArray(),
    });
  }

  selectDatumPlane(plane) {
    const object = this.referenceGroup.getObjectByName(`datum-${plane}`);
    if (!object) return;
    this.applySelection({
      kind: "datum-plane",
      plane,
      label: object.userData.label,
      normal: [...object.userData.normal],
      coordinate: 0,
      direction: 1,
      point: object.position.toArray(),
    });
  }

  applySelection(selection) {
    this.currentSelection = { ...selection };
    this.renderSelection(selection);
    this.callbacks.onSelection?.({ ...selection });
  }

  renderSelection(selection) {
    this.clearSelectionVisual();
    if (selection.kind === "datum-plane") {
      const plane = this.referenceGroup.getObjectByName(`datum-${selection.plane}`);
      if (plane) {
        plane.material.opacity = 0.25;
        plane.material.color.set(BLUE);
        plane.userData.selected = true;
      }
      return;
    }
    if (!this.currentBounds) return;
    const min = this.currentBounds.min;
    const max = this.currentBounds.max;
    const size = max.map((value, index) => value - min[index]);
    const center = min.map((value, index) => (value + max[index]) / 2);
    let geometry;
    const highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(
        selection.plane === "YZ" ? size[1] : size[0],
        selection.plane === "XY" ? size[1] : size[2],
      ),
      new THREE.MeshBasicMaterial({
        color: BLUE,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    if (selection.plane === "XY") {
      highlight.position.set(center[0], center[1], selection.coordinate + selection.direction * 0.02);
    } else if (selection.plane === "XZ") {
      highlight.rotation.x = Math.PI / 2;
      highlight.position.set(center[0], selection.coordinate + selection.direction * 0.02, center[2]);
    } else {
      highlight.rotation.y = Math.PI / 2;
      highlight.position.set(selection.coordinate + selection.direction * 0.02, center[1], center[2]);
    }
    highlight.name = "selected-face-highlight";
    this.selectionGroup.add(highlight);
  }

  clearSelectionVisual() {
    for (const plane of this.referenceGroup.children) {
      if (plane.isMesh) {
        plane.material.opacity = 0.075;
        plane.userData.selected = false;
      }
    }
    for (const child of [...this.selectionGroup.children]) {
      disposeObject(child);
      this.selectionGroup.remove(child);
    }
  }

  clearSelection() {
    this.currentSelection = null;
    this.clearSelectionVisual();
  }

  updateCamera() {
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.cos(this.yaw) * horizontal,
      this.target.y + Math.sin(this.yaw) * horizontal,
      this.target.z + Math.sin(this.pitch) * this.distance,
    );
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
  }

  alignToPlane(plane) {
    const selection = this.sketchSelection ?? this.currentSelection;
    if (!selection) return;
    const center = this.selectionPlaneCenter(selection);
    this.target.copy(center);
    const normal = new THREE.Vector3(...selection.normal).normalize();
    this.camera.up.set(0, plane === "XY" ? 1 : 0, plane === "XY" ? 0 : 1);
    const viewportHeight = Math.max(this.canvas.parentElement.clientHeight, 1);
    const worldHeight = viewportHeight * 0.25;
    this.distance = worldHeight /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.position.copy(center).addScaledVector(normal, this.distance);
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const container = this.canvas.parentElement;
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this.sketchMode && this.sketchSelection) {
      this.createSketchPlaneVisual(this.sketchSelection);
      this.alignToPlane(this.sketchSelection.plane);
    }
  }

  clearModel() {
    for (const child of [...this.modelGroup.children]) {
      disposeObject(child);
      this.modelGroup.remove(child);
    }
    this.currentBounds = null;
  }

  setMesh(mesh, bounds) {
    this.clearModel();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(mesh.vertices), 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    if (mesh.normals?.length === mesh.vertices.length) {
      geometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(mesh.normals, 3),
      );
    } else {
      geometry.computeVertexNormals();
    }
    geometry.computeBoundingSphere();

    const modelColor = QA_FLAT_COLOR_MODE ? CLEAR_COLOR : 0xcbd2da;
    const material = QA_FLAT_COLOR_MODE
      ? new THREE.MeshBasicMaterial({ color: modelColor })
      : new THREE.MeshStandardMaterial({
          color: modelColor,
          metalness: 0.12,
          roughness: 0.45,
          side: THREE.DoubleSide,
        });
    const solid = new THREE.Mesh(geometry, material);
    solid.castShadow = true;
    solid.receiveShadow = true;
    solid.name = "cad-solid";

    const edgeGeometry = new THREE.EdgesGeometry(geometry, 24);
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: QA_FLAT_COLOR_MODE ? CLEAR_COLOR : 0x344054,
      transparent: true,
      opacity: QA_FLAT_COLOR_MODE ? 1 : 0.5,
    });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.name = "cad-edges";
    this.modelGroup.add(solid, edges);

    if (bounds) {
      this.currentBounds = structuredClone(bounds);
      const minimum = new THREE.Vector3(...bounds.min);
      const maximum = new THREE.Vector3(...bounds.max);
      this.target.copy(minimum).add(maximum).multiplyScalar(0.5);
      const size = maximum.clone().sub(minimum);
      this.distance = Math.max(size.x, size.y, size.z, 10) * 2.25;
    }
    this.showReferencePlanes(false);
    this.clearSelection();
    this.fitView(false);
  }

  polygonExtrudeGeometry(profile, distance) {
    const shape = new THREE.Shape();
    profile.points.forEach((point, index) => {
      if (index === 0) shape.moveTo(point[0], point[1]);
      else shape.lineTo(point[0], point[1]);
    });
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: Number(distance),
      steps: 1,
      bevelEnabled: false,
      curveSegments: 1,
    });
    const positions = geometry.getAttribute("position");
    const offset = Number(profile.offset ?? 0);
    const direction = Number(profile.direction ?? 1) < 0 ? -1 : 1;
    for (let index = 0; index < positions.count; index += 1) {
      const u = positions.getX(index);
      const v = positions.getY(index);
      const w = positions.getZ(index) * direction;
      if (profile.plane === "XY") {
        positions.setXYZ(index, u, v, offset + w);
      } else if (profile.plane === "XZ") {
        positions.setXYZ(index, u, offset + w, v);
      } else {
        positions.setXYZ(index, offset + w, u, v);
      }
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  profilePlacement(profile, distance) {
    const direction = profile.direction ?? 1;
    const offset = Number(profile.offset ?? 0);
    const signedDistance = distance * direction;
    const polygonCenter = profile.type === "polygon"
      ? profile.points.reduce(
          (center, point) => [center[0] + point[0], center[1] + point[1]],
          [0, 0],
        ).map((value) => value / profile.points.length)
      : null;
    const u = profile.type === "circle"
      ? profile.center[0]
      : profile.type === "polygon"
        ? polygonCenter[0]
        : profile.origin[0] + profile.width / 2;
    const v = profile.type === "circle"
      ? profile.center[1]
      : profile.type === "polygon"
        ? polygonCenter[1]
        : profile.origin[1] + profile.height / 2;
    if (profile.plane === "XY") {
      return {
        size: ["circle", "polygon"].includes(profile.type) ? null : [profile.width, profile.height, distance],
        center: [u, v, offset + signedDistance / 2],
        arrowOrigin: [u, v, offset],
      };
    }
    if (profile.plane === "XZ") {
      return {
        size: ["circle", "polygon"].includes(profile.type) ? null : [profile.width, distance, profile.height],
        center: [u, offset + signedDistance / 2, v],
        arrowOrigin: [u, offset, v],
      };
    }
    return {
      size: ["circle", "polygon"].includes(profile.type) ? null : [distance, profile.width, profile.height],
      center: [offset + signedDistance / 2, u, v],
      arrowOrigin: [offset, u, v],
    };
  }

  showExtrudePreview(profile, distance) {
    this.clearExtrudePreview();
    this.previewDistance = Number(distance);
    this.previewProfile = structuredClone(profile);
    this.previewOperation = "extrude";
    const placement = this.profilePlacement(profile, this.previewDistance);
    const geometry = profile.type === "polygon"
      ? this.polygonExtrudeGeometry(profile, this.previewDistance)
      : new THREE.BoxGeometry(...placement.size);
    const preview = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x75aaf3,
        transparent: true,
        opacity: 0.28,
        roughness: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    if (profile.type !== "polygon") {
      preview.position.set(...placement.center);
    }
    preview.name = "extrude-preview";
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineDashedMaterial({ color: BLUE, dashSize: 3, gapSize: 2 }),
    );
    edges.computeLineDistances();
    preview.add(edges);
    this.previewGroup.add(preview);

    const direction = new THREE.Vector3(...profile.normal).normalize();
    const arrowLength = Math.max(this.previewDistance, 24);
    const arrowOrigin = new THREE.Vector3(...placement.arrowOrigin);
    const arrow = new THREE.ArrowHelper(
      direction,
      arrowOrigin,
      arrowLength,
      BLUE,
      Math.min(8, arrowLength * 0.28),
      Math.min(4.5, arrowLength * 0.16),
    );
    arrow.name = "extrude-arrow";
    this.previewGroup.add(arrow);

    const pickLength = arrowLength + 12;
    const pickGeometry = new THREE.CylinderGeometry(5, 5, pickLength, 12);
    const pickMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.001,
      depthWrite: false,
    });
    const pick = new THREE.Mesh(pickGeometry, pickMaterial);
    pick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    pick.position.copy(arrowOrigin).addScaledVector(direction, pickLength / 2);
    pick.name = "extrude-arrow-hit-target";
    this.previewGroup.add(pick);
    this.gizmoPickMesh = pick;
  }

  showCutPreview(profiles, distance) {
    this.clearExtrudePreview();
    if (!profiles?.length) return;
    this.previewDistance = Number(distance);
    this.previewProfile = structuredClone(profiles[0]);
    this.previewOperation = "cut";
    const cutColor = 0xc83b35;

    for (const profile of profiles) {
      const placement = this.profilePlacement(profile, this.previewDistance);
      let geometry;
      if (profile.type === "circle") {
        geometry = new THREE.CylinderGeometry(
          profile.radius,
          profile.radius,
          this.previewDistance,
          48,
        );
      } else if (profile.type === "polygon") {
        geometry = this.polygonExtrudeGeometry(profile, this.previewDistance);
      } else {
        geometry = new THREE.BoxGeometry(...placement.size);
      }
      const preview = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: cutColor,
          transparent: true,
          opacity: 0.3,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        }),
      );
      if (profile.type === "circle") {
        if (profile.plane === "XY") preview.rotation.x = Math.PI / 2;
        if (profile.plane === "YZ") preview.rotation.z = -Math.PI / 2;
      }
      if (profile.type !== "polygon") {
        preview.position.set(...placement.center);
      }
      preview.name = "cut-preview";
      preview.renderOrder = 8;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 18),
        new THREE.LineBasicMaterial({
          color: 0x9f2925,
          transparent: true,
          opacity: 0.9,
          depthTest: false,
        }),
      );
      preview.add(edges);
      this.previewGroup.add(preview);
    }

    const profile = profiles[0];
    const placement = this.profilePlacement(profile, this.previewDistance);
    const direction = new THREE.Vector3(...profile.normal).normalize();
    const arrowLength = Math.max(this.previewDistance, 24);
    const arrowOrigin = new THREE.Vector3(...placement.arrowOrigin);
    const arrow = new THREE.ArrowHelper(
      direction,
      arrowOrigin,
      arrowLength,
      cutColor,
      Math.min(8, arrowLength * 0.28),
      Math.min(4.5, arrowLength * 0.16),
    );
    arrow.name = "cut-arrow";
    arrow.renderOrder = 9;
    arrow.traverse((child) => {
      if (!child.material) return;
      child.material.depthTest = false;
      child.material.transparent = true;
      child.renderOrder = 9;
    });
    this.previewGroup.add(arrow);

    const pickLength = arrowLength + 12;
    const pickGeometry = new THREE.CylinderGeometry(5, 5, pickLength, 12);
    const pickMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.001,
      depthWrite: false,
      depthTest: false,
    });
    const pick = new THREE.Mesh(pickGeometry, pickMaterial);
    pick.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    pick.position.copy(arrowOrigin).addScaledVector(direction, pickLength / 2);
    pick.name = "cut-arrow-hit-target";
    this.previewGroup.add(pick);
    this.gizmoPickMesh = pick;
  }

  clearExtrudePreview() {
    this.gizmoPickMesh = null;
    this.previewOperation = null;
    this.previewProfile = null;
    this.previewDistance = null;
    for (const child of [...this.previewGroup.children]) {
      disposeObject(child);
      this.previewGroup.remove(child);
    }
  }

  projectPoint(point) {
    const projected = new THREE.Vector3(...point).project(this.camera);
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: bounds.left + ((projected.x + 1) / 2) * bounds.width,
      y: bounds.top + ((1 - projected.y) / 2) * bounds.height,
    };
  }

  getDatumScreenPoint(plane = "XY") {
    const uniquePoints = {
      XY: [88, 52, 0],
      XZ: [88, 0, 62],
      YZ: [0, 52, 62],
    };
    return uniquePoints[plane]
      ? this.projectPoint(uniquePoints[plane])
      : null;
  }

  getGizmoScreenPoint() {
    if (!this.previewProfile) return null;
    const placement = this.profilePlacement(
      this.previewProfile,
      Math.max(this.previewDistance, 24),
    );
    const direction = new THREE.Vector3(...this.previewProfile.normal).normalize();
    const point = new THREE.Vector3(...placement.arrowOrigin).addScaledVector(
      direction,
      Math.max(this.previewDistance, 24) * 0.72,
    );
    return this.projectPoint(point.toArray());
  }

  fitView(resetAngles = true) {
    this.camera.up.set(0, 0, 1);
    if (resetAngles) {
      this.yaw = -0.78;
      this.pitch = 0.62;
    }
    this.updateCamera();
  }

  zoom(factor) {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, 8, 2200);
    this.updateCamera();
  }

  animate() {
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(() => this.animate());
  }

  sampleColors(columns = 20, rows = 10) {
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const pixel = new Uint8Array(4);
    const colors = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(
          width - 1,
          Math.floor(((column + 0.5) / columns) * width),
        );
        const y = Math.min(
          height - 1,
          Math.floor(((row + 0.5) / rows) * height),
        );
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        colors.push(`${pixel[0]}:${pixel[1]}:${pixel[2]}:${pixel[3]}`);
      }
    }
    return {
      sampled: colors.length,
      unique: new Set(colors).size,
      colors,
    };
  }

  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.clearExtrudePreview();
    this.clearSelection();
    this.clearModel();
    this.renderer.dispose();
  }
}