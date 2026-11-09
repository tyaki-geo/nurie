import { describe, expect, it } from "vitest";
import { clampView, IDENTITY, MAX_SCALE, panBy, zoomAt } from "../src/lib/view";

describe("view", () => {
  it("カーソルの下の点は拡大しても動かない", () => {
    const v = zoomAt(IDENTITY, 2, 100, 50, 400, 300);
    // 画像上の点 (100, 50) は、表示でも (100, 50) のまま
    expect(v.tx + 100 * v.scale).toBeCloseTo(100);
    expect(v.ty + 50 * v.scale).toBeCloseTo(50);
  });
  it("等倍より縮小できず、拡大にも上限がある", () => {
    expect(zoomAt(IDENTITY, 0.5, 10, 10, 400, 300)).toEqual(IDENTITY);
    expect(zoomAt(IDENTITY, 1000, 10, 10, 400, 300).scale).toBe(MAX_SCALE);
  });
  it("画像は表示枠から外れない", () => {
    const v = zoomAt(IDENTITY, 2, 0, 0, 400, 300);
    expect(panBy(v, 999, 999, 400, 300)).toEqual({ scale: 2, tx: 0, ty: 0 });
    expect(panBy(v, -999, -999, 400, 300)).toEqual({ scale: 2, tx: -400, ty: -300 });
  });
  it("等倍では動かせない", () => {
    expect(panBy(IDENTITY, 50, 50, 400, 300)).toEqual(IDENTITY);
    expect(clampView({ scale: 1, tx: -5, ty: 5 }, 10, 10)).toEqual(IDENTITY);
  });
});
