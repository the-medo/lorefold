// WCAG relative luminance for opaque, six-digit sRGB colors.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
export function contrastRatio(a: string, b: string) {
  const luminance = (hex: string) => {
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
