/* CSS 颜色解析与色带纹理数据生成（纯函数，可单测） */

const NAMED_COLORS: Record<string, [number, number, number, number]> = {
  white: [255, 255, 255, 255],
  black: [0, 0, 0, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  lime: [0, 255, 0, 255],
  blue: [0, 0, 255, 255],
  yellow: [255, 255, 0, 255],
  orange: [255, 165, 0, 255],
  cyan: [0, 255, 255, 255],
  aqua: [0, 255, 255, 255],
  magenta: [255, 0, 255, 255],
  fuchsia: [255, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  silver: [192, 192, 192, 255],
  purple: [128, 0, 128, 255],
  pink: [255, 192, 203, 255],
  brown: [165, 42, 42, 255],
  navy: [0, 0, 128, 255],
  teal: [0, 128, 128, 255],
  transparent: [0, 0, 0, 0],
};

/** 解析 CSS 颜色为 [r,g,b,a]（0~255），支持 #rgb/#rgba/#rrggbb/#rrggbbaa、rgb()/rgba()、常用命名色 */
export function parseCssColor(input: string): [number, number, number, number] {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const v = hex.split("").map((c) => parseInt(c + c, 16));
      return [v[0], v[1], v[2], hex.length === 4 ? v[3] : 255];
    }
    if (hex.length === 6 || hex.length === 8) {
      const v: number[] = [];
      for (let i = 0; i < hex.length; i += 2) v.push(parseInt(hex.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], hex.length === 8 ? v[3] : 255];
    }
  }
  const fn = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (fn && (fn[1] === "rgb" || fn[1] === "rgba")) {
    const parts = fn[2].split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const rgb = parts.slice(0, 3).map((p) =>
        p.endsWith("%") ? Math.round((parseFloat(p) / 100) * 255) : Math.round(parseFloat(p))
      );
      let a = 255;
      if (parts.length >= 4) {
        a = parts[3].endsWith("%")
          ? Math.round((parseFloat(parts[3]) / 100) * 255)
          : Math.round(parseFloat(parts[3]) * 255);
      }
      return [rgb[0], rgb[1], rgb[2], a];
    }
  }
  if (s in NAMED_COLORS) return [...NAMED_COLORS[s]];
  throw new Error(`无法解析的颜色: "${input}"`);
}

/**
 * 由色带颜色数组生成 256 级色表（RGBA8），低→高风速线性插值。
 * 返回长度 256*4 的 Uint8Array，可直接作为 1D 纹理数据。
 */
export function makeColorTable(colors: string[], size = 256): Uint8Array {
  if (colors.length < 2) throw new Error("色带至少需要 2 个颜色");
  const stops = colors.map(parseCssColor);
  const out = new Uint8Array(size * 4);
  const segs = stops.length - 1;
  for (let i = 0; i < size; i++) {
    const t = (i / (size - 1)) * segs;
    const k = Math.min(Math.floor(t), segs - 1);
    const f = t - k;
    const a = stops[k];
    const b = stops[k + 1];
    out[i * 4 + 0] = Math.round(a[0] + (b[0] - a[0]) * f);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    out[i * 4 + 3] = Math.round(a[3] + (b[3] - a[3]) * f);
  }
  return out;
}
