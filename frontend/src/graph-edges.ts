import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";

const up = new THREE.Vector3(0, 1, 0);
const direction = new THREE.Vector3();
const projected = new THREE.Vector3();
const tip = new THREE.Vector3();

// The endpoints reference the node positions. Rebuild the path when a style
// changes the layout's depth, and release its previous GPU buffers.
export function rebuildEdge(line: Line2, curve: THREE.QuadraticBezierCurve3, lane: number) {
  direction.subVectors(curve.v2, curve.v0).normalize().cross(up);
  if (direction.lengthSq() < 0.01) direction.set(1, 0, 0);
  curve.v1.copy(curve.v0).lerp(curve.v2, 0.5).addScaledVector(direction.normalize(), 10 + lane * 10);
  line.geometry.dispose();
  line.geometry = new LineGeometry().setPositions(curve.getPoints(32).flatMap(point => point.toArray()));
  line.computeLineDistances();
}

export function placeArrow(arrow: THREE.Mesh, curve: THREE.QuadraticBezierCurve3, targetRadius: number) {
  const t = Math.max(0.5, 1 - (targetRadius + 4) / Math.max(curve.v0.distanceTo(curve.v2), 1));
  curve.getPoint(t, arrow.position);
  arrow.quaternion.setFromUnitVectors(up, curve.getTangent(t, direction));
  arrow.visible = true;
  arrow.scale.setScalar(1);
}

// Place the arrow just outside the projected disc even when an edge is steep
// or the marker has reached its on-screen size limit.
export function placeCircleArrow(arrow: THREE.Mesh, curve: THREE.QuadraticBezierCurve3, camera: THREE.PerspectiveCamera,
  width: number, height: number, focalLength: number, radiusPx: number) {
  tip.copy(curve.v2).project(camera);
  arrow.visible = tip.z > -1 && tip.z < 1 && Math.abs(tip.x) < 1.1 && Math.abs(tip.y) < 1.1;
  if (!arrow.visible) return;

  const lengthPx = THREE.MathUtils.clamp(radiusPx * 0.52, 3.5, 9);
  const clearance = radiusPx + lengthPx / 2 + 1;
  let outside = 0.5, inside = 1;
  for (let i = 0; i <= 8; i++) {
    const t = i === 0 ? outside : (outside + inside) / 2;
    curve.getPoint(t, projected).project(camera);
    const dx = (tip.x - projected.x) * width / 2;
    const dy = (tip.y - projected.y) * height / 2;
    if (Math.hypot(dx, dy) >= clearance) {
      outside = t;
      direction.set(dx, dy, 0);
    } else if (i === 0) {
      arrow.visible = false;
      return;
    } else {
      inside = t;
    }
  }
  curve.getPoint(outside, arrow.position);
  const depth = -projected.copy(arrow.position).applyMatrix4(camera.matrixWorldInverse).z;
  arrow.visible = depth > camera.near;
  if (!arrow.visible) return;
  arrow.scale.setScalar(lengthPx * depth / (4.8 * focalLength));
  arrow.quaternion.setFromUnitVectors(up, direction.normalize().applyQuaternion(camera.quaternion));
}
