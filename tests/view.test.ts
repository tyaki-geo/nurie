import { describe, expect, it } from "vitest";
import { centerView, clampView, fitSize, MARGIN, MAX_SCALE, panBy, zoomAt, type Frame } from "../src/lib/view";

// 枠 1000 × 700 の中に、紙面 400 × 300（等倍）
const f: Frame = { cw: 400, ch: 300, w: 1000, h: 700 };

describe("fitSize", () => {
  it("余白を残して枠に収まる（縦横比は保つ）", () => {
    const s = fitSize(2000, 1000, 1000, 700);
    expect(s.width).toBe(1000 - 2 * MARGIN);
    expect(s.height).toBe((1000 - 2 * MARGIN) / 2);
  });
  it("小さい画像の拡大は 4 倍まで", () => {
    expect(fitSize(10, 10, 1000, 1000).width).toBe(40);
  });
});

describe("view", () => {
  it("等倍では紙面が中央にある", () => {
    expect(centerView(f)).toEqual({ scale: 1, tx: 300, ty: 200 });
    expect(clampView({ scale: 1, tx: 0, ty: 0 }, f)).toEqual({ scale: 1, tx: 300, ty: 200 });
  });
  it("カーソルの下の点は拡大しても動かない", () => {
    const v = zoomAt(centerView(f), 2, 500, 350, f);
    // 紙面上の点 (200, 150) は、表示では (500, 350) のまま
    expect(v.tx + 200 * v.scale).toBeCloseTo(500);
    expect(v.ty + 150 * v.scale).toBeCloseTo(350);
  });
  it("縮小は等倍まで、拡大にも上限がある", () => {
    expect(zoomAt(centerView(f), 0.5, 10, 10, f)).toEqual(centerView(f));
    expect(zoomAt(centerView(f), 1000, 500, 350, f).scale).toBe(MAX_SCALE);
  });
  it("拡大すると紙面が枠より大きくなり、枠いっぱいを動ける（余白だけ残して端まで）", () => {
    const v = zoomAt(centerView(f), 5, 500, 350, f); // 紙面は 2000 × 1500
    expect(panBy(v, 99999, 99999, f)).toMatchObject({ tx: MARGIN, ty: MARGIN });
    expect(panBy(v, -99999, -99999, f)).toMatchObject({ tx: 1000 - 2000 - MARGIN, ty: 700 - 1500 - MARGIN });
  });
  it("枠に収まる間は動かせない", () => {
    expect(panBy(centerView(f), 50, 50, f)).toEqual(centerView(f));
  });
  it("片方の軸だけはみ出すときは、収まる軸は中央のまま", () => {
    const wide: Frame = { cw: 900, ch: 100, w: 1000, h: 700 };
    const v = zoomAt(centerView(wide), 2, 500, 350, wide); // 幅 1800（はみ出す）、高さ 200（収まる）
    expect(v.ty).toBe((700 - 200) / 2);
  });
});
