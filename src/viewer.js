import * as THREE from "../vendor/three.module.js";

const QA_FLAT_COLOR_MODE = false;
const CLEAR_COLOR = 0xfbfcfe;

export class CadViewer {
  constructor(canvas) {
    this.canvas = canvas;
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
    this.scene.add(this.modelGroup);
    this.target = new THREE.Vector3(50, 25, 10);
    this.distance = 180;
    this.yaw = -0.75;
    this.pitch = 0.58;
    this.dragging = false;
    this.lastPointer = { x: 0, y: 0 };

    this.addEnvironment();
    this.bindControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.fitView();
    this.animate();
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

  bindControls() {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
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
      this.dragging = false;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
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

  resize() {
    const container = this.canvas.parentElement;
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  clearModel() {
    for (const child of [...this.modelGroup.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      this.modelGroup.remove(child);
    }
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
      const minimum = new THREE.Vector3(...bounds.min);
      const maximum = new THREE.Vector3(...bounds.max);
      this.target.copy(minimum).add(maximum).multiplyScalar(0.5);
      const size = maximum.clone().sub(minimum);
      this.distance = Math.max(size.x, size.y, size.z, 10) * 2.25;
    }
    this.fitView(false);
  }

  fitView(resetAngles = true) {
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
    this.clearModel();
    this.renderer.dispose();
  }
}
