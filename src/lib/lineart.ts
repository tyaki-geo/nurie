// 線画の処理。DOM に依存しないのでテストしやすい。
// 画像は RGBA（1画素4バイト）の配列で受け取る。

/** 色 [r, g, b]（各 0〜255） */
export type Rgb = readonly [number, number, number];

/** 黒さ 0〜1。黒 = 1、白や色のついた画素 = 0 に近い。透明は白として扱う */
export function darkness(r: number, g: number, b: number, a: number): number {
  const alpha = a / 255;
  // 白地に重ねたときの各色
  const rr = r * alpha + 255 * (1 - alpha);
  const gg = g * alpha + 255 * (1 - alpha);
  const bb = b * alpha + 255 * (1 - alpha);
  // 「黒い線」だけを拾うので、いちばん明るいチャンネルで測る（赤 (255,0,0) は黒ではない）
  return 1 - Math.max(rr, gg, bb) / 255;
}

/** 画素ごとの黒さ（0〜255）。しきい値を変えても作り直さなくてよいよう、しきい値の処理とは分けてある */
export function computeDarkness(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out[i] = Math.round(darkness(rgba[o]!, rgba[o + 1]!, rgba[o + 2]!, rgba[o + 3]!) * 255);
  }
  return out;
}

/** しきい値（黒さがこの値以上なら線）。小さいほど薄い線まで拾う。0〜255 だが 2 未満にはしない */
function limit(threshold: number): number {
  return Math.max(2, threshold);
}

/**
 * 線の濃さ（0〜255）。黒さがしきい値以上なら完全な黒、しきい値の半分以下なら線なし、
 * その間はなめらかにつなぐ（縁のなめらかさを残すため）。
 */
export function lineAlpha(dark: Uint8Array, threshold: number): Uint8Array {
  const t = limit(threshold);
  const lo = t / 2;
  const out = new Uint8Array(dark.length);
  for (let i = 0; i < dark.length; i++) {
    const d = dark[i]!;
    if (d >= t) out[i] = 255;
    else if (d > lo) out[i] = Math.round(((d - lo) / (t - lo)) * 255);
  }
  return out;
}

/** 塗れる画素（線ではない画素）か */
export function isPaintable(dark: Uint8Array, threshold: number, index: number): boolean {
  return dark[index]! < limit(threshold);
}

/**
 * (x, y) から、線で囲まれた領域の画素の番号を集める（4近傍）。
 * 始点が線の上、または範囲外なら空。
 */
export function floodRegion(
  dark: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  x: number,
  y: number,
): Int32Array {
  if (x < 0 || y < 0 || x >= width || y >= height) return new Int32Array(0);
  const start = y * width + x;
  if (!isPaintable(dark, threshold, start)) return new Int32Array(0);

  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const out: number[] = [];
  let sp = 0;
  stack[sp++] = start;
  seen[start] = 1;

  const visit = (i: number): void => {
    if (seen[i] || !isPaintable(dark, threshold, i)) return;
    seen[i] = 1;
    stack[sp++] = i;
  };

  while (sp > 0) {
    const i = stack[--sp]!;
    out.push(i);
    const cx = i % width;
    const cy = (i - cx) / width;
    if (cx > 0) visit(i - 1);
    if (cx < width - 1) visit(i + 1);
    if (cy > 0) visit(i - width);
    if (cy < height - 1) visit(i + width);
  }
  return Int32Array.from(out);
}

/**
 * 塗った色（colors: RGBA、初期は白）に線を重ねた最終画像を out に書く。
 * 線が濃い画素ほど黒に近づく。[from, to) の画素だけ更新できる（省略で全画素）。
 */
export function compose(
  colors: Uint8ClampedArray,
  alpha: Uint8Array,
  out: Uint8ClampedArray,
  from = 0,
  to = alpha.length,
): void {
  for (let i = from; i < to; i++) {
    const o = i * 4;
    const k = 1 - alpha[i]! / 255; // 塗った色の残り具合
    out[o] = colors[o]! * k;
    out[o + 1] = colors[o + 1]! * k;
    out[o + 2] = colors[o + 2]! * k;
    out[o + 3] = 255;
  }
}

/** "#rrggbb" / "rrggbb" / "#rgb" を色に。不正なら null */
export function parseHex(text: string): Rgb | null {
  let s = text.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function toHex(color: Rgb): string {
  return "#" + color.map((v) => clampChannel(v).toString(16).padStart(2, "0")).join("");
}

/** 0〜255 の整数に丸める。数でなければ 0 */
export function clampChannel(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(255, Math.max(0, Math.round(v)));
}

/** 長辺が max を超えるときの縮小後のサイズ（縦横比を保つ。超えなければそのまま） */
export function fitSize(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
