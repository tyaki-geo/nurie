import { describe, expect, it } from "vitest";
import { hsvToRgb, rgbToHsv } from "../src/lib/hsv";

describe("hsv", () => {
  it("原色", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(0, 255, 0).h).toBe(120);
    expect(rgbToHsv(0, 0, 255).h).toBe(240);
    expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
    expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
    expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
  });
  it("黒・白・灰色は彩度 0", () => {
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv(255, 255, 255)).toEqual({ h: 0, s: 0, v: 1 });
    expect(hsvToRgb(200, 0, 0.5)).toEqual([128, 128, 128]);
  });
  it("往復で元の色に戻る", () => {
    for (const [r, g, b] of [[229, 57, 53], [30, 136, 229], [142, 36, 170], [255, 204, 153]] as const) {
      const { h, s, v } = rgbToHsv(r, g, b);
      expect(hsvToRgb(h, s, v)).toEqual([r, g, b]);
    }
  });
});
