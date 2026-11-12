import { CanvasTexture, SRGBColorSpace } from "three";
import type { EntityKind } from "../../shared/contracts.js";
import type { ThemeConfig } from "../../shared/themes.js";
import { contrastRatio } from "../../shared/theme-colors.js";

export const mapStyles = { bookplate: "Bookplate", observatory: "Observatory", circles: "Circles", wayfinder: "Wayfinder" } as const;
export type MapStyle = keyof typeof mapStyles;

// Miniature engravings inside each bookplate seal, in a 64 × 64 design space.
const engravings: Record<EntityKind, string> = {
  character: "M19 46 Q20 39 28 37 L28 33 Q24 31 24 25 Q24 17 32 17 Q39 17 39 24 L42 28 L39 29 L39 33 Q38 35 34 35 L35 38 Q43 39 45 46 Z M25 24 Q29 24 31 20 Q33 24 38 25 M24 40 L30 44 L35 38 M27 46 L30 44 L34 46",
  location: "M15 44 L27 22 L34 33 L39 25 L50 44 Z M22 32 L27 28 L30 30 M34 33 L38 39 M18 47 H47 M21 44 L26 35 M25 44 L28 39 M41 32 L46 42",
  faction: "M23 49 V16 M24 19 Q29 16 35 19 T45 19 V34 Q40 37 34 33 T24 33 Z M27 22 Q31 21 35 23 M27 26 Q31 25 35 27 M18 48 H28",
  object: "M16 28 L24 20 H40 L48 28 L32 46 Z M16 28 H48 M24 20 L27 28 L32 46 L37 28 L40 20 M27 28 L32 20 L37 28",
};
const signs: Record<EntityKind, string> = {
  character: "M32 16 A7 7 0 1 1 32 30 A7 7 0 1 1 32 16 M18 46 Q18 32 32 32 Q46 32 46 46 Z",
  location: "M32 13 C15 13 15 30 22 37 L32 49 L42 37 C49 29 49 13 32 13 Z M32 20 A5.5 5.5 0 1 1 32 31 A5.5 5.5 0 1 1 32 20",
  faction: "M15 40 L24 22 L33 40 Z M31 40 L40 22 L49 40 Z M25 22 L32 11 L39 22 Z",
  object: "M32 14 L50 32 L32 50 L14 32 Z M32 24 L24 32 L32 40 L40 32 Z",
};

export function createMarkerTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function paintMarker(texture: CanvasTexture, style: MapStyle, kind: EntityKind, colors: ThemeConfig["colors"]) {
  const canvas = texture.image as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(canvas.width / 64, 0, 0, canvas.height / 64, 0, 0);
  ctx.clearRect(0, 0, 64, 64);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const color = colors[kind];
  function circle(x: number, y: number, radius: number, fill: string) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  function arc(radius: number, stroke: string, width: number, from = 0, to = 2 * Math.PI) {
    ctx.beginPath();
    ctx.arc(32, 32, radius, from, to);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  if (style === "bookplate") {
    const ink = `color-mix(in srgb, ${color} 67%, ${colors.text})`;
    const paper = `color-mix(in srgb, ${colors.surface} 86%, ${color})`;
    circle(32, 32, 32, ink);
    circle(32, 32, 29.6, paper);
    arc(26.4, ink, 1);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.1;
    ctx.stroke(new Path2D(engravings[kind]));
    for (const x of [9, 55]) circle(x, 32, 1.3, ink);
  } else if (style === "observatory") {
    const phosphor = `color-mix(in srgb, ${color} 58%, #efffff)`;
    circle(32, 32, 31.6, `color-mix(in srgb, #101727 84%, ${color})`);
    arc(30.5, color, 1.3);
    arc(22, phosphor, 1.6, 0.2, 4.2);
    arc(22, color, 1, 4.6, 6);
    const angle = { character: 0.95, location: 2.7, faction: 4.55, object: 5.55 }[kind];
    circle(32 + 22 * Math.cos(angle), 32 + 22 * Math.sin(angle), 3.6, phosphor);
    circle(32, 32, 12.6, color);
    ctx.fillStyle = "#fff";
    ctx.fill(new Path2D("M32 22 Q33 31 41 32 Q33 33 32 42 Q31 33 23 32 Q31 31 32 22 Z"));
  } else if (style === "circles") {
    circle(32, 32, 32, color);
    circle(32, 32, 28.5, `color-mix(in srgb, ${color} 25%, ${colors.surface})`);
  } else {
    const sign = contrastRatio(color, "#121827") > contrastRatio(color, "#ffffff") ? "#121827" : "#ffffff";
    circle(32, 32, 32, colors.text);
    circle(32, 32, 29.6, colors.surface);
    circle(32, 32, 26.1, color);
    ctx.fillStyle = sign;
    ctx.fill(new Path2D(signs[kind]), "evenodd");
  }
  texture.needsUpdate = true;
}
