const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function polygonArea(points) {
  return Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
}

export class SketchEditor {
  constructor(svg, { onChange, onDimension }) {
    this.svg = svg;
    this.onChange = onChange;
    this.onDimension = onDimension;
    this.entities = [];
    this.activeTool = null;
    this.drawing = null;
    this.snapPoint = null;
    this.mmPerPixel = 0.25;

    svg.addEventListener("pointerdown", (event) => this.pointerDown(event));
    svg.addEventListener("pointermove", (event) => this.pointerMove(event));
    svg.addEventListener("pointerup", (event) => this.pointerUp(event));
    svg.addEventListener("pointercancel", () => this.cancelDrawing());
    svg.addEventListener("dblclick", (event) => this.doubleClick(event));
  }

  setTool(tool) {
    this.activeTool = tool;
    this.svg.classList.toggle("active", Boolean(tool));
    document.querySelectorAll("[data-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    });
  }

  clear() {
    this.entities = [];
    this.drawing = null;
    this.render();
  }

  setEntities(entities) {
    this.entities = structuredClone(entities ?? []);
    this.render();
  }

  localPoint(event) {
    const bounds = this.svg.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }

  endpoints() {
    const points = [];
    for (const entity of this.entities) {
      if (entity.type === "line") {
        points.push(entity.start, entity.end);
      } else if (entity.type === "rectangle") {
        const { start, end } = entity;
        points.push(
          start,
          end,
          { x: start.x, y: end.y },
          { x: end.x, y: start.y },
        );
      } else if (entity.type === "circle") {
        points.push(entity.center);
      }
    }
    return points;
  }

  snapped(point) {
    let nearest = null;
    let nearestDistance = 11;
    for (const candidate of this.endpoints()) {
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    this.snapPoint = nearest ? { ...nearest } : null;
    return nearest ? { ...nearest } : point;
  }

  pointerDown(event) {
    if (!["line", "rectangle", "circle"].includes(this.activeTool)) return;
    const point = this.snapped(this.localPoint(event));
    this.drawing = {
      id: `sketch-${Date.now()}-${Math.round(point.x)}`,
      type: this.activeTool,
      start: point,
      end: point,
      center: point,
      radius: 0,
    };
    this.svg.setPointerCapture(event.pointerId);
    this.render();
  }

  pointerMove(event) {
    const raw = this.localPoint(event);
    document.querySelector("#coordinate-status").textContent =
      `X: ${(raw.x * this.mmPerPixel).toFixed(2)}　` +
      `Y: ${(raw.y * this.mmPerPixel).toFixed(2)}　Z: 0.00`;
    if (!this.drawing) return;
    const point = this.snapped(raw);
    this.drawing.end = point;
    this.drawing.radius = Math.hypot(
      point.x - this.drawing.center.x,
      point.y - this.drawing.center.y,
    );
    this.render();
  }

  pointerUp(event) {
    if (!this.drawing) return;
    const span =
      this.drawing.type === "circle"
        ? this.drawing.radius
        : Math.hypot(
            this.drawing.end.x - this.drawing.start.x,
            this.drawing.end.y - this.drawing.start.y,
          );
    if (span >= 6) {
      this.entities.push(structuredClone(this.drawing));
      this.onChange?.(this.entities);
    }
    this.drawing = null;
    this.snapPoint = null;
    if (this.svg.hasPointerCapture(event.pointerId)) {
      this.svg.releasePointerCapture(event.pointerId);
    }
    this.render();
  }

  cancelDrawing() {
    this.drawing = null;
    this.snapPoint = null;
    this.render();
  }

  doubleClick(event) {
    const target = event.target.closest("[data-entity-id]");
    if (!target) return;
    const entity = this.entities.find(
      (candidate) => candidate.id === target.dataset.entityId,
    );
    if (!entity) return;
    const dimension = target.dataset.dimension || "primary";
    let value = 0;
    let label = "尺寸";
    if (entity.type === "rectangle") {
      if (dimension === "height") {
        value = Math.abs(entity.end.y - entity.start.y) * this.mmPerPixel;
        label = "矩形高度";
      } else {
        value = Math.abs(entity.end.x - entity.start.x) * this.mmPerPixel;
        label = "矩形宽度";
      }
    } else if (entity.type === "circle") {
      value = entity.radius * this.mmPerPixel * 2;
      label = "圆直径";
    } else {
      value =
        Math.hypot(
          entity.end.x - entity.start.x,
          entity.end.y - entity.start.y,
        ) * this.mmPerPixel;
      label = "线长度";
    }
    this.onDimension?.({ entity, dimension, value, label });
  }

  updateDimension(entityId, dimension, millimetres) {
    const entity = this.entities.find((candidate) => candidate.id === entityId);
    if (!entity || !Number.isFinite(millimetres) || millimetres <= 0) return;
    const pixels = millimetres / this.mmPerPixel;
    if (entity.type === "rectangle") {
      if (dimension === "height") {
        const sign = Math.sign(entity.end.y - entity.start.y) || 1;
        entity.end.y = entity.start.y + sign * pixels;
      } else {
        const sign = Math.sign(entity.end.x - entity.start.x) || 1;
        entity.end.x = entity.start.x + sign * pixels;
      }
    } else if (entity.type === "circle") {
      entity.radius = pixels / 2;
    } else {
      const angle = Math.atan2(
        entity.end.y - entity.start.y,
        entity.end.x - entity.start.x,
      );
      entity.end.x = entity.start.x + Math.cos(angle) * pixels;
      entity.end.y = entity.start.y + Math.sin(angle) * pixels;
    }
    this.render();
    this.onChange?.(this.entities);
  }

  getRectangle() {
    return [...this.entities]
      .reverse()
      .find((entity) => entity.type === "rectangle");
  }

  getCircles() {
    return this.entities.filter((entity) => entity.type === "circle");
  }

  analyseLineProfiles(tolerance = 1.5) {
    const lines = this.entities.filter((entity) => entity.type === "line");
    const nodes = [];
    const edges = [];
    const nodeFor = (point) => {
      const existing = nodes.findIndex(
        (node) => pointDistance(node.point, point) <= tolerance,
      );
      if (existing >= 0) {
        nodes[existing].maximumGap = Math.max(
          nodes[existing].maximumGap,
          pointDistance(nodes[existing].point, point),
        );
        return existing;
      }
      nodes.push({ point: { ...point }, edges: [], maximumGap: 0 });
      return nodes.length - 1;
    };

    let degenerateLineCount = 0;
    for (const line of lines) {
      const start = nodeFor(line.start);
      const end = nodeFor(line.end);
      if (start === end) {
        degenerateLineCount += 1;
        continue;
      }
      const edgeIndex = edges.length;
      edges.push({ id: line.id, start, end });
      nodes[start].edges.push(edgeIndex);
      nodes[end].edges.push(edgeIndex);
    }

    const visitedEdges = new Set();
    const profiles = [];
    let openEndpointCount = 0;
    let branchPointCount = 0;
    for (let seed = 0; seed < edges.length; seed += 1) {
      if (visitedEdges.has(seed)) continue;
      const componentEdges = [];
      const componentNodes = new Set();
      const queue = [seed];
      while (queue.length) {
        const edgeIndex = queue.pop();
        if (visitedEdges.has(edgeIndex)) continue;
        visitedEdges.add(edgeIndex);
        componentEdges.push(edgeIndex);
        const edge = edges[edgeIndex];
        componentNodes.add(edge.start);
        componentNodes.add(edge.end);
        for (const nodeIndex of [edge.start, edge.end]) {
          for (const neighbour of nodes[nodeIndex].edges) {
            if (!visitedEdges.has(neighbour)) queue.push(neighbour);
          }
        }
      }

      const degrees = [...componentNodes].map(
        (nodeIndex) => nodes[nodeIndex].edges.length,
      );
      openEndpointCount += degrees.filter((degree) => degree === 1).length;
      branchPointCount += degrees.filter((degree) => degree > 2).length;
      const isCycle =
        componentEdges.length >= 3 &&
        componentEdges.length === componentNodes.size &&
        degrees.every((degree) => degree === 2);
      if (!isCycle) continue;

      const firstEdgeIndex = componentEdges[0];
      const firstEdge = edges[firstEdgeIndex];
      const orderedNodes = [firstEdge.start];
      const orderedEdges = [];
      let currentNode = firstEdge.start;
      let previousEdge = -1;
      do {
        const nextEdge = nodes[currentNode].edges.find(
          (edgeIndex) => edgeIndex !== previousEdge,
        );
        if (nextEdge === undefined) break;
        orderedEdges.push(nextEdge);
        const edge = edges[nextEdge];
        currentNode = edge.start === currentNode ? edge.end : edge.start;
        previousEdge = nextEdge;
        if (currentNode !== orderedNodes[0]) orderedNodes.push(currentNode);
      } while (
        currentNode !== orderedNodes[0] &&
        orderedEdges.length <= componentEdges.length
      );

      const points = orderedNodes.map((nodeIndex) => ({
        ...nodes[nodeIndex].point,
      }));
      if (
        currentNode === orderedNodes[0] &&
        orderedEdges.length === componentEdges.length &&
        polygonArea(points) >= 1
      ) {
        profiles.push({
          type: "polygon",
          points,
          lineIds: orderedEdges.map((edgeIndex) => edges[edgeIndex].id),
          closureGap: Math.max(
            0,
            ...orderedNodes.map((nodeIndex) => nodes[nodeIndex].maximumGap),
          ),
          areaPixels: polygonArea(points),
        });
      }
    }

    return {
      profiles,
      lineCount: lines.length,
      openEndpointCount,
      branchPointCount,
      degenerateLineCount,
    };
  }

  getClosedLineProfiles() {
    return this.analyseLineProfiles().profiles;
  }

  rectangleDimensions(entity = this.getRectangle()) {
    if (!entity) return null;
    return {
      width: Math.max(
        0.1,
        Math.abs(entity.end.x - entity.start.x) * this.mmPerPixel,
      ),
      depth: Math.max(
        0.1,
        Math.abs(entity.end.y - entity.start.y) * this.mmPerPixel,
      ),
      origin: {
        x: Math.min(entity.start.x, entity.end.x),
        y: Math.min(entity.start.y, entity.end.y),
      },
    };
  }

  renderEntity(entity, preview = false) {
    const group = svgElement("g");
    group.dataset.entityId = entity.id;
    const className = `sketch-entity${preview ? " preview" : ""}`;
    if (entity.type === "rectangle") {
      const x = Math.min(entity.start.x, entity.end.x);
      const y = Math.min(entity.start.y, entity.end.y);
      const width = Math.abs(entity.end.x - entity.start.x);
      const height = Math.abs(entity.end.y - entity.start.y);
      const rectangle = svgElement("rect", {
        x,
        y,
        width,
        height,
        class: className,
        "data-entity-id": entity.id,
      });
      group.append(rectangle);
      if (!preview) {
        const widthText = svgElement("text", {
          x: x + width / 2,
          y: y - 10,
          "text-anchor": "middle",
          class: "sketch-dimension",
          "data-entity-id": entity.id,
          "data-dimension": "width",
        });
        widthText.textContent = `${(width * this.mmPerPixel).toFixed(1)} mm`;
        const heightText = svgElement("text", {
          x: x + width + 12,
          y: y + height / 2,
          class: "sketch-dimension",
          "data-entity-id": entity.id,
          "data-dimension": "height",
        });
        heightText.textContent = `${(height * this.mmPerPixel).toFixed(1)} mm`;
        group.append(widthText, heightText);
      }
    } else if (entity.type === "circle") {
      group.append(
        svgElement("circle", {
          cx: entity.center.x,
          cy: entity.center.y,
          r: entity.radius,
          class: className,
          "data-entity-id": entity.id,
        }),
      );
      if (!preview) {
        const text = svgElement("text", {
          x: entity.center.x + entity.radius + 10,
          y: entity.center.y,
          class: "sketch-dimension",
          "data-entity-id": entity.id,
          "data-dimension": "diameter",
        });
        text.textContent = `φ${(entity.radius * 2 * this.mmPerPixel).toFixed(1)}`;
        group.append(text);
      }
    } else {
      group.append(
        svgElement("line", {
          x1: entity.start.x,
          y1: entity.start.y,
          x2: entity.end.x,
          y2: entity.end.y,
          class: className,
          "data-entity-id": entity.id,
        }),
      );
    }
    return group;
  }

  render() {
    this.svg.replaceChildren();
    for (const entity of this.entities) {
      this.svg.append(this.renderEntity(entity));
    }
    if (this.drawing) {
      this.svg.append(this.renderEntity(this.drawing, true));
    }
    if (this.snapPoint) {
      this.svg.append(
        svgElement("circle", {
          cx: this.snapPoint.x,
          cy: this.snapPoint.y,
          r: 6,
          class: "snap-indicator",
        }),
      );
    }
  }
}
