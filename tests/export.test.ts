import { describe, expect, it } from "vitest";
import { aspectRatio, exportSize, isAspect, isFormat } from "../src/lib/export";

describe("aspectRatio", () => {
  it("幅:高さを比にする", () => {
    expect(aspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(aspectRatio("1:1")).toBe(1);
  });
  it("original と不正な値は null", () => {
    expect(aspectRatio("original")).toBeNull();
    expect(aspectRatio("0:3")).toBeNull();
    expect(aspectRatio("abc")).toBeNull();
  });
});

describe("exportSize", () => {
  it("original は元の大きさ", () => {
    expect(exportSize(300, 200, "original")).toEqual({ width: 300, height: 200 });
  });
  it("横長の画像を 1:1 にすると高さを足す", () => {
    expect(exportSize(300, 200, "1:1")).toEqual({ width: 300, height: 300 });
  });
  it("縦長の画像を 16:9 にすると幅を足す", () => {
    expect(exportSize(200, 400, "16:9")).toEqual({ width: 711, height: 400 });
  });
  it("画像は縮小されない", () => {
    for (const a of ["1:1", "4:3", "3:4", "16:9", "9:16"]) {
      const s = exportSize(500, 321, a);
      expect(s.width).toBeGreaterThanOrEqual(500);
      expect(s.height).toBeGreaterThanOrEqual(321);
    }
  });
});

describe("型ガード", () => {
  it("形式と比を判定する", () => {
    expect(isFormat("webp")).toBe(true);
    expect(isFormat("gif")).toBe(false);
    expect(isAspect("9:16")).toBe(true);
    expect(isAspect("5:7")).toBe(false);
  });
});
