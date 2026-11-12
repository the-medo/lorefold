import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { ChevronDown, Palette, Focus, Maximize, Minimize, Minus, Plus, RotateCcw } from "lucide-react";
import type { Entity, Relationship } from "../../shared/contracts.js";
import { createMarkerTexture, mapStyles, paintMarker, type MapStyle } from "./graph-markers.js";
import { LabelSpace } from "./graph-labels.js";
import { layoutGraph } from "./graph-layout.js";

import { useTheme } from "./theme.js";

type MapActions = { zoom: (factor: number) => void; reset: () => void; select: (id: string | null, focus?: boolean) => void; restyle: () => void };
type NodeView = {
  entity: Entity;
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  label: HTMLButtonElement;
  radius: number;
  degree: number;
  labelWidth: number;
  labelHeight: number;
  screenX: number;
  screenY: number;
  offsetY: number;
};
type EdgeView = { relationship: Relationship; line: Line2; arrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>; label: HTMLSpanElement; position: THREE.Vector3 };

export function StoryGraph({ entities, relationships, selectedId = null, onSelect }: {
  entities: Entity[]; relationships: Relationship[]; selectedId?: string | null; onSelect: (id: string) => void;
}) {
  const theme = useTheme();
  const [style, setStyle] = useState<MapStyle>("bookplate");
  const currentStyle = useRef(style);
  currentStyle.current = style;
  const palette = useRef(theme.colors);
  palette.current = theme.colors;
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const actions = useRef<MapActions | null>(null);
  const selectCallback = useRef(onSelect);
  const selected = useRef(selectedId);
  const previousSelection = useRef<string | null>(null);
  selectCallback.current = onSelect;
  selected.current = selectedId;
  const hintId = useId();
  const [fallback, setFallback] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);

  useLayoutEffect(() => {
    const element = host.current, labelLayer = labels.current;
    if (!element || !labelLayer || !entities.length) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch {
      setFallback(true);
      return;
    }
    setFallback(false);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "3D story relationship map");
    canvas.setAttribute("aria-describedby", hintId);
    element.append(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
    const controls = new OrbitControls(camera, canvas);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    controls.enableDamping = !reducedMotion.matches;
    controls.dampingFactor = 0.12;
    controls.minDistance = 35;
    controls.rotateSpeed = 0.65;
    controls.panSpeed = 0.7;
    controls.zoomSpeed = 0.8;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    const positions = layoutGraph(entities, relationships);
    const geometry = new THREE.CircleGeometry(1, 64);
    const textures = new Map<Entity["kind"], THREE.CanvasTexture>();
    const nodes = new Map<string, NodeView>();
    const meshes: THREE.Object3D[] = [];
    const edgeViews: EdgeView[] = [];
    let width = 1, height = 1, frame = 0, disposed = false, lost = false;
    let labelSpace: LabelSpace | undefined;
    let measureLabels = true;
    let active = selected.current;
    let tween: { start: number; from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
    let hovered: string | null = null;
    const neighbors = new Set<string>();
    const ringMaterial = new THREE.MeshBasicMaterial({ color: palette.current.mapSelection, transparent: true, opacity: 0.8, depthTest: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 64), ringMaterial);
    ring.visible = false;
    ring.renderOrder = 3;
    scene.add(ring);

    const initialAspect = element.clientWidth / Math.max(1, element.clientHeight);
    const horizontalScale = THREE.MathUtils.clamp(initialAspect, 0.8, 2.5);
    for (const entity of entities) {
      const radius = entity.kind === "character" ? 14 : 12.5;
      let texture = textures.get(entity.kind);
      if (!texture) {
        texture = createMarkerTexture();
        textures.set(entity.kind, texture);
      }
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 2;
      const p = positions.get(entity.id)!;
      mesh.position.set(p.x * horizontalScale, p.y, p.z);
      mesh.scale.setScalar(radius);
      mesh.userData.entityId = entity.id;
      scene.add(mesh);
      meshes.push(mesh);
      const label = document.createElement("button");
      label.className = "map-node-label";
      label.type = "button";
      label.textContent = entity.label;
      label.setAttribute("aria-label", `Inspect ${entity.label}`);
      label.addEventListener("click", () => selectCallback.current(entity.id));
      labelLayer.append(label);
      nodes.set(entity.id, { entity, mesh, radius, label, degree: 0, labelWidth: 0, labelHeight: 0, screenX: 0, screenY: 0, offsetY: 0 });
    }
    const pairCounts = new Map<string, number>();
    for (const relationship of relationships) {
      const source = nodes.get(relationship.source), target = nodes.get(relationship.target);
      if (!source || !target) continue;
      source.degree++;
      target.degree++;
      const pair = [relationship.source, relationship.target].sort().join("\0");
      const lane = pairCounts.get(pair) ?? 0;
      pairCounts.set(pair, lane + 1);
      const start = source.mesh.position, end = target.mesh.position;
      const direction = end.clone().sub(start).normalize();
      const side = direction.clone().cross(new THREE.Vector3(0, 1, 0));
      if (side.lengthSq() < 0.01) side.set(1, 0, 0);
      side.normalize();
      const midpoint = start.clone().lerp(end, 0.5).addScaledVector(side, 10 + lane * 10);
      const curve = new THREE.QuadraticBezierCurve3(start.clone(), midpoint, end.clone());
      const line = new Line2(
        new LineGeometry().setPositions(curve.getPoints(32).flatMap(point => point.toArray())),
        new LineMaterial({ transparent: true, depthWrite: false, dashSize: 2, gapSize: 3 }),
      );
      line.computeLineDistances();
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.9, 4.8, 12), new THREE.MeshBasicMaterial({ color: palette.current.mapEdge, transparent: true, depthWrite: false, opacity: 0.65 }));
      const t = Math.max(0.5, 1 - (target.radius + 4) / Math.max(start.distanceTo(end), 1));
      arrow.position.copy(curve.getPoint(t));
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(t).normalize());
      scene.add(line, arrow);
      const label = document.createElement("span");
      label.className = "map-edge-label";
      label.textContent = relationship.label;
      label.hidden = true;
      labelLayer.append(label);
      edgeViews.push({ relationship, line, arrow, label, position: curve.getPoint(0.5) });
    }
    const byDegree = [...nodes.values()].sort((a, b) => b.degree - a.degree || a.entity.id.localeCompare(b.entity.id));
    const initialDirection = new THREE.Vector3(0, 0, 1);
    const bounds = new THREE.Box3().setFromPoints([...nodes.values()].map(node => node.mesh.position));
    const center = bounds.getCenter(new THREE.Vector3());
    const homePosition = new THREE.Vector3();
    let homeDistance = 0;
    function fitDistance() {
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      // Leave screen-space room for the names and controls even in portrait.
      const halfWidth = Math.max(width * 0.25, width / 2 - 72);
      const verticalMargin = width < 600 ? 84 : 65;
      const halfHeight = Math.max(height * 0.23, height / 2 - verticalMargin);
      const focalLength = height / (2 * tangent);
      let distance = 0;
      for (const { mesh, radius } of nodes.values()) {
        const { x, y, z } = mesh.position;
        const scale = Math.max(
          (Math.abs(x - center.x) + radius) / halfWidth,
          (Math.abs(y - center.y) + radius) / halfHeight,
          radius / 32,
        );
        distance = Math.max(distance, z - center.z + focalLength * scale);
      }
      return distance;
    }
    function invalidate() {
      if (!disposed && !lost && !document.hidden && !frame) frame = requestAnimationFrame(render);
    }
    function moveTo(position: THREE.Vector3, target: THREE.Vector3) {
      if (reducedMotion.matches) {
        camera.position.copy(position);
        controls.target.copy(target);
        controls.update();
      } else {
        tween = { start: performance.now(), from: camera.position.clone(), to: position.clone(), fromTarget: controls.target.clone(), toTarget: target.clone() };
      }
      invalidate();
    }
    function reset() {
      moveTo(homePosition, center);
    }
    function highlight(id: string | null, focus = false) {
      active = id && nodes.has(id) ? id : null;
      neighbors.clear();
      if (active) {
        neighbors.add(active);
        for (const edge of edgeViews) {
          if (edge.relationship.source === active) neighbors.add(edge.relationship.target);
          if (edge.relationship.target === active) neighbors.add(edge.relationship.source);
        }
      }
      const style = currentStyle.current;
      const colors = palette.current;
      for (const [nodeId, node] of nodes) {
        const solid = style === "circles" && nodeId === active;
        const material = node.mesh.material;
        const texture = solid ? null : textures.get(node.entity.kind)!;
        if (material.map !== texture) {
          material.map = texture;
          material.needsUpdate = true;
        }
        material.color.set(solid ? colors[node.entity.kind] : 0xffffff);
        const relevant = !active || neighbors.has(nodeId);
        node.mesh.material.opacity = relevant ? 1 : 0.22;
        node.mesh.material.depthWrite = relevant;
        node.label.classList.toggle("is-muted", !relevant);
        node.label.classList.toggle("is-selected", nodeId === active);
        node.label.setAttribute("aria-pressed", String(nodeId === active));
      }
      for (const edge of edgeViews) {
        const connected = edge.relationship.source === active || edge.relationship.target === active;
        const line = edge.line.material;
        line.color.set(connected ? colors.mapSelection : colors.mapEdge);
        if (style === "observatory") line.color.lerp(new THREE.Color("#c5eaff"), 0.25);
        if (style === "wayfinder" && !connected) {
          const source = nodes.get(edge.relationship.source)!;
          line.color.lerp(new THREE.Color(colors[source.entity.kind]), 0.7);
        }
        line.dashed = style === "observatory";
        line.linewidth = style === "wayfinder" ? 3.4 : style === "bookplate" ? 1.5 : 1.2;
        line.opacity = active && !connected ? 0.12 : 1;
        edge.arrow.material.color.copy(line.color);
        edge.arrow.material.opacity = active && !connected ? 0.12 : 1;
        edge.label.dataset.connected = String(connected);
      }
      const node = active ? nodes.get(active) : undefined;
      ring.visible = !!node;
      if (node) {
        ring.position.copy(node.mesh.position);
        ringMaterial.color.set(style === "circles" ? colors[node.entity.kind] : colors.mapSelection);
        ring.scale.setScalar(style === "circles" ? node.radius * 1.34 : node.radius + 2.6);
        if (focus) {
          const direction = camera.position.clone().sub(controls.target).normalize();
          // Keep the selected node's neighborhood in view rather than diving into the marker.
          moveTo(node.mesh.position.clone().addScaledVector(direction, homeDistance * 0.82), node.mesh.position.clone());
        }
      }
      invalidate();
    }
    const projected = new THREE.Vector3();
    const viewPosition = new THREE.Vector3();
    function screenPosition(position: THREE.Vector3, label: HTMLElement) {
      projected.copy(position).project(camera);
      const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
      const visible = projected.z > -1 && projected.z < 1 && x > 6 && x < width - 6 && y > 8 && y < height - 35;
      label.hidden = !visible;
      if (visible) {
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
      }
      return visible;
    }
    function placeLabel(space: LabelSpace, node: NodeView, pinned = false) {
      const left = THREE.MathUtils.clamp(node.screenX - node.labelWidth / 2, 0, Math.max(0, width - node.labelWidth));
      const offsets = [node.offsetY, -node.offsetY - node.labelHeight];
      for (const offset of offsets) {
        const top = node.screenY + offset;
        if (top < 0 || top + node.labelHeight > height) continue;
        if (space.reserve(left - 2, top - 1, node.labelWidth + 4, node.labelHeight + 2, pinned)) {
          node.label.style.left = `${left + node.labelWidth / 2}px`;
          node.label.style.transform = `translate(-50%, ${offset}px)`;
          node.label.hidden = false;
          return true;
        }
      }
      node.label.hidden = true;
      return false;
    }
    function render(now: number) {
      frame = 0;
      if (disposed || lost || document.hidden) return;
      if (tween) {
        const elapsed = Math.min(1, (now - tween.start) / 450);
        const eased = 1 - Math.pow(1 - elapsed, 3);
        camera.position.lerpVectors(tween.from, tween.to, eased);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        if (elapsed === 1) tween = null;
      }
      const moving = controls.update();
      camera.updateMatrixWorld();
      ring.quaternion.copy(camera.quaternion);
      for (const { mesh } of nodes.values()) mesh.quaternion.copy(camera.quaternion);
      renderer.render(scene, camera);
      if (labelSpace && measureLabels) {
        for (const { label } of nodes.values()) label.hidden = false;
        for (const node of nodes.values()) {
          node.labelWidth = node.label.offsetWidth;
          node.labelHeight = node.label.offsetHeight;
        }
        measureLabels = false;
      }
      labelSpace?.clear();
      const visible: NodeView[] = [];
      for (const node of byDegree) {
        if (screenPosition(node.mesh.position, node.label)) {
          viewPosition.copy(node.mesh.position).applyMatrix4(camera.matrixWorldInverse);
          const pixelRadius = node.mesh.scale.x * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * -viewPosition.z);
          const outerRadius = node.entity.id === active && currentStyle.current === "circles"
            ? pixelRadius * ring.scale.x / node.mesh.scale.x : pixelRadius;
          node.offsetY = Math.max(12, outerRadius + 5);
          if (labelSpace) {
            node.screenX = (projected.x + 1) * width / 2;
            node.screenY = (1 - projected.y) * height / 2;
            labelSpace.reserve(node.screenX - pixelRadius, node.screenY - pixelRadius, 2 * pixelRadius, 2 * pixelRadius, true);
            visible.push(node);
          } else {
            node.label.style.transform = `translate(-50%, ${node.offsetY}px)`;
          }
        }
      }
      if (labelSpace) {
        // Show a few landmarks in the overview. Zooming makes room for more
        // names, and selecting an entity gives its neighborhood priority.
        const budget = Math.max(4, Math.ceil(width * height / 34000 * homeDistance / controls.getDistance()));
        let shown = 0;
        for (const node of visible) {
          if (node.entity.id === active || node.entity.id === hovered || node.label === document.activeElement) {
            placeLabel(labelSpace, node, true);
          } else {
            node.label.hidden = true;
          }
        }
        for (const node of visible) {
          if (shown >= budget) break;
          if (node.label.hidden && (!active || neighbors.has(node.entity.id)) && placeLabel(labelSpace, node)) shown++;
        }
      }
      for (const edge of edgeViews) {
        if (active && edge.label.dataset.connected === "true") screenPosition(edge.position, edge.label);
        else edge.label.hidden = true;
      }
      if (moving || tween) invalidate();
    }
    const fontsChanged = () => { measureLabels = true; invalidate(); };
    document.fonts.addEventListener("loadingdone", fontsChanged);
    const resize = () => {
      const atHome = !homeDistance || (!tween && camera.position.distanceToSquared(homePosition) < 1e-6 && controls.target.distanceToSquared(center) < 1e-6);
      width = Math.max(1, element.clientWidth);
      height = Math.max(1, element.clientHeight);
      labelSpace = nodes.size > 35 ? new LabelSpace(width, height) : undefined;
      measureLabels = true;
      homeDistance = fitDistance();
      homePosition.copy(center).addScaledVector(initialDirection, homeDistance);
      controls.maxDistance = Math.max(1400, homeDistance * 2);
      camera.far = Math.max(3000, controls.maxDistance + bounds.min.distanceTo(bounds.max));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      if (atHome) {
        controls.target.copy(center);
        camera.position.copy(homePosition);
        controls.update();
      }
      invalidate();
    };
    resize();
    controls.addEventListener("change", invalidate);
    const interrupt = () => { tween = null; };
    controls.addEventListener("start", interrupt);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number; id: number } | null = null;
    let dragged = false;
    const pressed = new Set<number>();
    function pick(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(meshes, false)[0]?.object.userData.entityId as string | undefined;
    }
    const pointerDown = (event: PointerEvent) => {
      pressed.add(event.pointerId);
      if (pressed.size === 1 && event.button === 0) {
        down = { x: event.clientX, y: event.clientY, id: event.pointerId }; dragged = false;
      } else { down = null; dragged = true; }
    };
    const pointerMove = (event: PointerEvent) => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) dragged = true;
      if (pressed.size) return;
      const id = pick(event) ?? null;
      if (id === hovered) return;
      hovered = id;
      canvas.style.cursor = id ? "pointer" : "grab";
      for (const [nodeId, node] of nodes) node.mesh.scale.setScalar(node.radius * (nodeId === id ? 1.12 : 1));
      invalidate();
    };
    const pointerUp = (event: PointerEvent) => {
      pressed.delete(event.pointerId);
      if (down?.id === event.pointerId && !dragged) {
        const id = pick(event);
        if (id) selectCallback.current(id);
      }
      down = null;
    };
    const pointerCancel = (event: PointerEvent) => { pressed.delete(event.pointerId); down = null; dragged = true; };
    const zoom = (factor: number) => { tween = null; controls.dollyIn(1 / factor); controls.update(); invalidate(); };
    const keyDown = (event: KeyboardEvent) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "0", "Home"];
      if (!keys.includes(event.key)) return;
      event.preventDefault(); tween = null;
      if (event.key === "ArrowLeft") controls.rotateLeft(0.12);
      if (event.key === "ArrowRight") controls.rotateLeft(-0.12);
      if (event.key === "ArrowUp") controls.rotateUp(0.12);
      if (event.key === "ArrowDown") controls.rotateUp(-0.12);
      if (event.key === "+" || event.key === "=") zoom(1.2);
      if (event.key === "-") zoom(1 / 1.2);
      if (event.key === "0" || event.key === "Home") reset();
      controls.update(); invalidate();
    };
    const contextLost = (event: Event) => { event.preventDefault(); lost = true; setFallback(true); labelLayer.style.visibility = "hidden"; };
    const contextRestored = () => setRetry((value) => value + 1);
    const motionChanged = () => { controls.enableDamping = !reducedMotion.matches; if (reducedMotion.matches && tween) { camera.position.copy(tween.to); controls.target.copy(tween.toTarget); tween = null; } invalidate(); };
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerCancel);
    canvas.addEventListener("keydown", keyDown);
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);
    document.addEventListener("visibilitychange", invalidate);
    reducedMotion.addEventListener("change", motionChanged);
    labelLayer.style.visibility = "visible";
    const restyle = () => {
      for (const [kind, texture] of textures) paintMarker(texture, currentStyle.current, kind, palette.current);
      measureLabels = true;
      highlight(active);
    };
    actions.current = { zoom, reset, select: highlight, restyle };
    restyle();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", fontsChanged);
      controls.removeEventListener("change", invalidate);
      controls.removeEventListener("start", interrupt);
      controls.dispose();
      document.removeEventListener("visibilitychange", invalidate);
      reducedMotion.removeEventListener("change", motionChanged);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerCancel);
      canvas.removeEventListener("keydown", keyDown);
      geometry.dispose();
      for (const texture of textures.values()) texture.dispose();
      for (const node of nodes.values()) node.mesh.material.dispose();
      for (const edge of edgeViews) { edge.line.geometry.dispose(); edge.line.material.dispose(); edge.arrow.geometry.dispose(); edge.arrow.material.dispose(); }
      ring.geometry.dispose(); ringMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss();
      canvas.remove(); labelLayer.replaceChildren();
      actions.current = null;
    };
  }, [entities, relationships, retry, hintId]);

  // Apply palette and label typography changes in the existing scene.
  useLayoutEffect(() => { actions.current?.restyle(); }, [theme, style]);

  useLayoutEffect(() => {
    actions.current?.select(selectedId, !!selectedId);
    if (!selectedId && previousSelection.current) actions.current?.reset();
    previousSelection.current = selectedId;
  }, [selectedId]);
  async function fullscreen() {
    try {
      setError("");
      if (document.fullscreenElement === wrap.current) await document.exitFullscreen();
      else await wrap.current?.requestFullscreen();
    } catch { setError("Fullscreen is unavailable in this browser."); }
  }
  const selectedEntity = entities.find((entity) => entity.id === selectedId);
  return <div className="graph-wrap graph-three" data-map-style={style} ref={wrap} role="region" aria-label="Interactive 3D story map">
    <div className="graph-canvas" ref={host} />
    <div className="map-labels" ref={labels} />
    {!fallback && !!entities.length && <label className="map-style-picker">
      <Palette size={14} aria-hidden="true" />
      <select aria-label="Map style" value={style} onChange={(event) => setStyle(event.target.value as MapStyle)}>
        {Object.entries(mapStyles).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
      </select>
      <ChevronDown size={12} aria-hidden="true" />
    </label>}
    {expanded && selectedEntity && <button className="map-selection secondary" onClick={fullscreen}>View {selectedEntity.label} details</button>}
    {fallback && entities.length > 0 && <div className="graph-fallback" role="status"><p>The 3D map needs WebGL. Explore the same people, places, and connections in the list below.</p><button className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry 3D map</button></div>}
    {!entities.length && <p className="graph-fallback">No matches. Try another search or filter.</p>}
    {!fallback && entities.length > 0 && <p className="map-hint" id={hintId}>Drag to orbit · Scroll or pinch to zoom<span> · Right-drag to pan</span><span className="sr-only">. With the map focused, use arrow keys to orbit, plus or minus to zoom, and Home to reset. Use the entity list below for keyboard selection.</span></p>}
    {error && <p className="map-error" role="alert">{error}</p>}
    <div className="graph-controls">
      <button className="icon-button" aria-label="Zoom in" disabled={fallback || !entities.length} onClick={() => actions.current?.zoom(1.2)}><Plus size={17} /></button>
      <button className="icon-button" aria-label="Zoom out" disabled={fallback || !entities.length} onClick={() => actions.current?.zoom(1 / 1.2)}><Minus size={17} /></button>
      <button className="icon-button" aria-label="Focus selected entity" disabled={fallback || !entities.some((entity) => entity.id === selectedId)} onClick={() => actions.current?.select(selectedId, true)}><Focus size={17} /></button>
      <button className="icon-button" aria-label="Reset map view" disabled={fallback || !entities.length} onClick={() => actions.current?.reset()}><RotateCcw size={16} /></button>
      <button className="icon-button" aria-label={expanded ? "Exit fullscreen map" : "Expand map"} onClick={fullscreen}>{expanded ? <Minimize size={16} /> : <Maximize size={16} />}</button>
    </div>
  </div>;
}
