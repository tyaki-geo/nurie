// キャンバスの表示位置の計算。DOM に依存しない。
//
// 表示枠（viewport）は作業領域いっぱいで、紙面（キャンバス）はその中に置く。
// 拡大しても紙面の「枠」は紙面と一緒に大きくなるので、作業領域全体が視野になる。

/** キャンバスの表示位置。表示枠の左上を原点に、紙面（等倍の大きさ cw × ch）を scale 倍して (tx, ty) だけずらす */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** 紙面（等倍の表示サイズ cw × ch）と表示枠（w × h） */
export interface Frame {
  cw: number;
  ch: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 40;
/** 紙面の周りに残す余白（px）。端まで寄せたときも、紙面の外側にこれだけ視野が残る */
export const MARGIN = 48;

/** 画像（iw × ih）を表示枠（w × h）に、余白を残して収まるように表示するときの大きさ。拡大は 4 倍まで */
export function fitSize(
  iw: number,
  ih: number,
  w: number,
  h: number,
  margin = MARGIN,
): { width: number; height: number } {
  const k = Math.min(4, Math.max(0.01, (w - 2 * margin) / iw), Math.max(0.01, (h - 2 * margin) / ih));
  return { width: Math.max(1, Math.round(iw * k)), height: Math.max(1, Math.round(ih * k)) };
}

/** 紙面を表示枠の中央に置いた等倍の表示位置 */
export function centerView(f: Frame): View {
  return { scale: 1, tx: (f.w - f.cw) / 2, ty: (f.h - f.ch) / 2 };
}

/** 1軸分: 紙面が枠に余白つきで収まるなら中央、はみ出すなら端が余白の位置まで */
function clampAxis(t: number, content: number, frame: number): number {
  if (content + 2 * MARGIN <= frame + 0.5) return (frame - content) / 2;
  return Math.min(MARGIN, Math.max(frame - content - MARGIN, t));
}

/** 拡大率を範囲内に収め、紙面が枠から離れすぎないように位置を直す */
export function clampView(v: View, f: Frame): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  return {
    scale,
    tx: clampAxis(v.tx, f.cw * scale, f.w),
    ty: clampAxis(v.ty, f.ch * scale, f.h),
  };
}

/** 枠内の点 (cx, cy) を動かさずに factor 倍する */
export function zoomAt(v: View, factor: number, cx: number, cy: number, f: Frame): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
  const k = scale / v.scale;
  return clampView({ scale, tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k }, f);
}

/** 画面上で (dx, dy) だけ平行移動する */
export function panBy(v: View, dx: number, dy: number, f: Frame): View {
  return clampView({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }, f);
}
