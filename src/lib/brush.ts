// 太さのあるブラシの当たり判定。DOM に依存しない。

/**
 * 点 (x0, y0) から (x1, y1) まで、半径 radius の丸いブラシでなぞったときに覆う画素の番号。
 * 画素の中心が線分から radius 以内にあるものを返す。画像の外は含まない。
 */
export function capsulePixels(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  width: number,
  height: number,
): Int32Array {
  const r = Math.max(0.5, radius);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + r));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const out: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // 画素の中心から線分への最短距離
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      t = Math.min(1, Math.max(0, t));
      const ex = px - (x0 + t * dx);
      const ey = py - (y0 + t * dy);
      if (ex * ex + ey * ey <= r * r) out.push(y * width + x);
    }
  }
  return Int32Array.from(out);
}
