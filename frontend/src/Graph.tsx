import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Focus, Maximize, Minimize, Minus, Plus, RotateCcw } from "lucide-react";
import type { Entity, Relationship } from "../../shared/contracts.js";
import { layoutGraph } from "./graph-layout.js";

import { useTheme } from "./theme.js";

type MapActions = { zoom: (factor: number) => void; reset: () => void; select: (id: string | null, focus?: boolean) => void; recolor: () => void };
type NodeView = { entity: Entity; mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>; label: HTMLButtonElement; radius: number };
type EdgeView = { relationship: Relationship; line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>; arrow: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>; label: HTMLSpanElement; position: THREE.Vector3 };

export function StoryGraph({ entities, relationships, selectedId = null, onSelect }: {
  entities: Entity[]; relationships: Relationship[]; selectedId?: string | null; onSelect: (id: string) => void;
}) {
  const theme = useTheme();
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
    controls.maxDistance = 1400;
    controls.rotateSpeed = 0.65;
    controls.panSpeed = 0.7;
    controls.zoomSpeed = 0.8;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    scene.add(new THREE.AmbientLight(0xffffff, 1.7));
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(-100, 180, 250);
    scene.add(light);
    const positions = layoutGraph(entities, relationships);
    const geometry = new THREE.SphereGeometry(1, 24, 16);
    const nodes = new Map<string, NodeView>();
    const meshes: THREE.Object3D[] = [];
    const edgeViews: EdgeView[] = [];
    let width = 1, height = 1, frame = 0, disposed = false, lost = false;
    let active: string | null = null;
    let tween: { start: number; from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3 } | null = null;
    let hovered: string | null = null;
    const neighbors = new Set<string>();
    const ringMaterial = new THREE.MeshBasicMaterial({ color: palette.current.mapSelection, transparent: true, opacity: 0.8, depthTest: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 64), ringMaterial);
    ring.visible = false;
    scene.add(ring);

    for (const entity of entities) {
      const radius = entity.kind === "character" ? 7.5 : 6;
      const material = new THREE.MeshStandardMaterial({ color: palette.current[entity.kind], roughness: 0.38, metalness: 0.08, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const p = positions.get(entity.id)!;
      mesh.position.set(p.x, p.y, p.z);
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
      nodes.set(entity.id, { entity, mesh, radius, label });
    }
    const pairCounts = new Map<string, number>();
    for (const relationship of relationships) {
      const source = nodes.get(relationship.source), target = nodes.get(relationship.target);
      if (!source || !target) continue;
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
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), new THREE.LineBasicMaterial({ color: palette.current.mapEdge, transparent: true, opacity: 0.45 }));
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4, 8), new THREE.MeshBasicMaterial({ color: palette.current.mapEdge, transparent: true, opacity: 0.65 }));
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
    const radius = Math.max(50, ...[...nodes.values()].map((node) => node.mesh.position.length() + node.radius));
    const initialDirection = new THREE.Vector3(0.25, 0.18, 1).normalize();
    function fitDistance() {
      const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const effectiveFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
      return radius / Math.sin(effectiveFov) * 1.3;
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
        tween = { start: performance.now(), from: camera.position.clone(), to: position, fromTarget: controls.target.clone(), toTarget: target };
      }
      invalidate();
    }
    function reset() {
      moveTo(initialDirection.clone().multiplyScalar(fitDistance()), new THREE.Vector3());
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
      for (const [nodeId, node] of nodes) {
        const relevant = !active || neighbors.has(nodeId);
        node.mesh.material.opacity = relevant ? 1 : 0.22;
        node.mesh.material.depthWrite = relevant;
        node.label.classList.toggle("is-muted", !relevant);
        node.label.classList.toggle("is-selected", nodeId === active);
        node.label.setAttribute("aria-pressed", String(nodeId === active));
      }
      for (const edge of edgeViews) {
        const connected = edge.relationship.source === active || edge.relationship.target === active;
        edge.line.material.opacity = active ? connected ? 0.9 : 0.08 : 0.4;
        edge.line.material.color.set(connected ? palette.current.mapSelection : palette.current.mapEdge);
        edge.arrow.material.color.copy(edge.line.material.color);
        edge.arrow.material.opacity = active ? connected ? 1 : 0.1 : 0.65;
        edge.label.dataset.connected = String(connected);
      }
      const node = active ? nodes.get(active) : undefined;
      ring.visible = !!node;
      if (node) {
        ring.position.copy(node.mesh.position);
        ring.scale.setScalar(node.radius + 2.6);
        if (focus) {
          const direction = camera.position.clone().sub(controls.target).normalize();
          // Keep the selected node's neighborhood in view rather than diving into its sphere.
          moveTo(node.mesh.position.clone().addScaledVector(direction, fitDistance() * 0.82), node.mesh.position.clone());
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
      renderer.render(scene, camera);
      for (const node of nodes.values()) {
        if (screenPosition(node.mesh.position, node.label)) {
          viewPosition.copy(node.mesh.position).applyMatrix4(camera.matrixWorldInverse);
          const pixelRadius = node.mesh.scale.x * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * -viewPosition.z);
          node.label.style.transform = `translate(-50%, ${Math.max(12, pixelRadius + 5)}px)`;
        }
      }
      for (const edge of edgeViews) {
        if (active && edge.label.dataset.connected === "true") screenPosition(edge.position, edge.label);
        else edge.label.hidden = true;
      }
      if (moving || tween) invalidate();
    }
    const resize = () => {
      width = Math.max(1, element.clientWidth);
      height = Math.max(1, element.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      invalidate();
    };
    resize();
    camera.position.copy(initialDirection).multiplyScalar(fitDistance());
    camera.lookAt(0, 0, 0);
    controls.update();
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
    actions.current = { zoom, reset, select: highlight, recolor: () => {
      for (const node of nodes.values()) node.mesh.material.color.set(palette.current[node.entity.kind]);
      ringMaterial.color.set(palette.current.mapSelection);
      highlight(active);
    } };
    highlight(selected.current);
    invalidate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
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
      for (const node of nodes.values()) node.mesh.material.dispose();
      for (const edge of edgeViews) { edge.line.geometry.dispose(); edge.line.material.dispose(); edge.arrow.geometry.dispose(); edge.arrow.material.dispose(); }
      ring.geometry.dispose(); ringMaterial.dispose();
      renderer.dispose(); renderer.forceContextLoss();
      canvas.remove(); labelLayer.replaceChildren();
      actions.current = null;
    };
  }, [entities, relationships, retry, hintId]);

  // Recolor existing materials without resetting orbit, selection, or GPU resources.
  useLayoutEffect(() => { actions.current?.recolor(); }, [theme.colors]);

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
  return <div className="graph-wrap graph-three" ref={wrap} role="region" aria-label="Interactive 3D story map">
    <div className="graph-canvas" ref={host} />
    <div className="map-labels" ref={labels} />
    <span className="map-dimension">3D STORY MAP</span>
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
