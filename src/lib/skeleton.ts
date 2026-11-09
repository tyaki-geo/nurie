// 線の中心（芯）を求めて、ブラシを線に沿わせるための計算。DOM に依存しない。

/**
 * 各画素から、いちばん近い「元」の画素（source が 1 の画素）までの距離（画素単位）。
 * 3×3 の 2 パス（chamfer）による近似で、誤差は 1 割未満。元がなければ Infinity。
 */
export function distanceTransform(source: Uint8Array, width: number, height: number): Float32Array {
  const n = width * height;
  const d = new Float32Array(n);
  const D2 = Math.SQRT2;
  for (let i = 0; i < n; i++) d[i] = source[i] ? 0 : Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        v = Math.min(v, d[i - width]! + 1);
        if (x > 0) v = Math.min(v, d[i - width - 1]! + D2);
        if (x < width - 1) v = Math.min(v, d[i - width + 1]! + D2);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x < width - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < height - 1) {
        v = Math.min(v, d[i + width]! + 1);
        if (x < width - 1) v = Math.min(v, d[i + width + 1]! + D2);
        if (x > 0) v = Math.min(v, d[i + width - 1]! + D2);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * 線（line が 1 の画素）の芯。線の縁からの距離が、まわりの 8 画素のどれにも負けない画素を芯とする
 * （太い線は縁から最も遠い中央の筋、細い線は線そのもの）。画像の端は縁とみなさない。
 */
export function ridgeOf(line: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const notLine = new Uint8Array(n);
  for (let i = 0; i < n; i++) notLine[i] = line[i] ? 0 : 1;
  const d = distanceTransform(notLine, width, height);
  const ridge = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!line[i]) continue;
      const v = d[i]!;
      let top = true;
      for (let dy = -1; dy <= 1 && top; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || (dx === 0 && dy === 0)) continue;
          if (d[yy * width + xx]! > v + 1e-6) {
            top = false;
            break;
          }
        }
      }
      if (top) ridge[i] = 1;
    }
  }
  return ridge;
}

export interface SnapPoint {
  x: number;
  y: number;
}

/**
 * (x, y) の近く（半径 radius 以内）にある線の芯のうち、もっとも近いものの中心を返す。
 * prev（直前の吸着先）があれば、そこから近いものを少し優先して、近くの別の線に飛び移りにくくする。
 * 見つからなければ null。
 */
export function snapToRidge(
  ridge: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  prev: SnapPoint | null = null,
): SnapPoint | null {
  const minX = Math.max(0, Math.floor(x - radius));
  const maxX = Math.min(width - 1, Math.ceil(x + radius));
  const minY = Math.max(0, Math.floor(y - radius));
  const maxY = Math.min(height - 1, Math.ceil(y + radius));
  let best = Infinity;
  let bx = -1;
  let by = -1;
  for (let yy = minY; yy <= maxY; yy++) {
    for (let xx = minX; xx <= maxX; xx++) {
      if (!ridge[yy * width + xx]) continue;
      const px = xx + 0.5;
      const py = yy + 0.5;
      const dp = Math.hypot(px - x, py - y);
      if (dp > radius) continue;
      const cost = prev ? dp + 0.5 * Math.hypot(px - prev.x, py - prev.y) : dp;
      if (cost < best) {
        best = cost;
        bx = px;
        by = py;
      }
    }
  }
  return bx < 0 ? null : { x: bx, y: by };
}
