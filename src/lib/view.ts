/** キャンバスの表示位置。表示枠の左上を原点に、画像を scale 倍して (tx, ty) だけずらす */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 40;
export const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };

/** 拡大率を範囲内に収め、画像が表示枠（w × h）から外れないように位置を直す */
export function clampView(v: View, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  const tx = Math.min(0, Math.max(w * (1 - scale), v.tx));
  const ty = Math.min(0, Math.max(h * (1 - scale), v.ty));
  return { scale, tx, ty };
}

/** 表示枠内の点 (cx, cy) を動かさずに factor 倍する */
export function zoomAt(v: View, factor: number, cx: number, cy: number, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return clampView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }, w, h);
}

/** 画面上で (dx, dy) だけ平行移動する */
export function panBy(v: View, dx: number, dy: number, w: number, h: number): View {
  return clampView({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }, w, h);
}
