// 隙間の確認ポップアップの小さなプレビューの拡大縮小。DOM に依存しない。
// プレビューは隙間の位置を中心に、画像の span × span 画素を切り出して見せる。拡大縮小は中心を動かさず span だけを変える。

export const DEFAULT_SPAN = 64;
/** 最も拡大したとき（画素）。8 画素を 96px に引き伸ばす */
export const MIN_SPAN = 8;
/** 最も縮小したとき（画素） */
export const MAX_SPAN = 512;

/** ホイールの回転量（deltaY。上向きが負）に応じて span を変える。上に回すと拡大（span が小さくなる） */
export function zoomSpan(span: number, deltaY: number): number {
  const next = span * Math.exp(deltaY * 0.0015);
  return Math.min(MAX_SPAN, Math.max(MIN_SPAN, next));
}

/** 倍率（初期の span を 1 倍とした値） */
export function spanScale(span: number): number {
  return DEFAULT_SPAN / span;
}
