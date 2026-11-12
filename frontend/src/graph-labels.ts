// A small screen-space mask keeps label placement bounded by the viewport,
// even when many projected nodes occupy the same area.
export class LabelSpace {
  private cell = 4;
  private columns: number;
  private rows: number;
  private pixels: Uint8Array;

  constructor(width: number, height: number) {
    this.columns = Math.ceil(width / this.cell);
    this.rows = Math.ceil(height / this.cell);
    this.pixels = new Uint8Array(this.columns * this.rows);
  }

  clear() { this.pixels.fill(0); }

  reserve(x: number, y: number, width: number, height: number, force = false) {
    const left = Math.max(0, Math.floor(x / this.cell));
    const right = Math.min(this.columns, Math.ceil((x + width) / this.cell));
    const top = Math.max(0, Math.floor(y / this.cell));
    const bottom = Math.min(this.rows, Math.ceil((y + height) / this.cell));
    if (!force) {
      for (let row = top; row < bottom; row++) {
        for (let col = left; col < right; col++) {
          if (this.pixels[row * this.columns + col]) return false;
        }
      }
    }
    for (let row = top; row < bottom; row++) {
      this.pixels.fill(1, row * this.columns + left, row * this.columns + right);
    }
    return true;
  }
}
