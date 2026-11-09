import { describe, expect, it } from "vitest";
import { capsulePixels } from "../src/lib/brush";

describe("capsulePixels", () => {
  it("点（長さ0）は円", () => {
    const px = capsulePixels(5, 5, 5, 5, 2, 10, 10);
    // 中心 (5,5) から半径 2 以内にある画素の中心
    expect(px).toContain(5 * 10 + 5);
    expect(px).toContain(4 * 10 + 4);
    expect(px).not.toContain(5 * 10 + 8);
    expect(px.length).toBeGreaterThan(8);
    expect(px.length).toBeLessThan(20);
  });
  it("線分に沿って太さの分だけ覆う", () => {
    const px = capsulePixels(1, 5, 8, 5, 1, 10, 10);
    expect(px).toContain(5 * 10 + 4);
    expect(px).toContain(4 * 10 + 4); // 太さ（半径1）の分、上下も覆う
    expect(px).not.toContain(2 * 10 + 4);
  });
  it("太さを大きくすると覆う画素が増える", () => {
    const thin = capsulePixels(2, 5, 8, 5, 1, 20, 10).length;
    const thick = capsulePixels(2, 5, 8, 5, 3, 20, 10).length;
    expect(thick).toBeGreaterThan(thin * 2);
  });
  it("画像の外は含まない", () => {
    const px = capsulePixels(0, 0, 0, 0, 5, 4, 4);
    expect(px.every((i) => i >= 0 && i < 16)).toBe(true);
    expect(px.length).toBeLessThanOrEqual(16);
  });
});
