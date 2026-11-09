import { describe, expect, it } from "vitest";
import {
  clampChannel,
  compose,
  computeDarkness,
  darkness,
  fitSize,
  floodRegion,
  lineAlpha,
  parseHex,
  toHex,
} from "../src/lib/lineart";

/** 文字の絵から RGBA を作る。# = 黒、. = 白、r = 赤 */
function image(rows: string[]): { rgba: Uint8ClampedArray; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const c = ch === "#" ? [0, 0, 0] : ch === "r" ? [255, 0, 0] : [255, 255, 255];
      rgba.set([...c, 255], (y * w + x) * 4);
    }),
  );
  return { rgba, w, h };
}

describe("darkness", () => {
  it("黒は1、白は0、赤は黒ではない", () => {
    expect(darkness(0, 0, 0, 255)).toBe(1);
    expect(darkness(255, 255, 255, 255)).toBe(0);
    expect(darkness(255, 0, 0, 255)).toBe(0);
  });
  it("透明は白として扱う", () => {
    expect(darkness(0, 0, 0, 0)).toBe(0);
  });
  it("濃いグレーは黒に近い", () => {
    expect(darkness(30, 30, 30, 255)).toBeGreaterThan(0.85);
  });
});

describe("lineAlpha", () => {
  it("しきい値以上は完全な黒、半分以下は線なし、間はなめらか", () => {
    const a = lineAlpha(Uint8Array.from([255, 128, 100, 64, 0]), 128);
    expect(a[0]).toBe(255);
    expect(a[1]).toBe(255);
    expect(a[2]).toBeGreaterThan(0);
    expect(a[2]).toBeLessThan(255);
    expect(a[3]).toBe(0);
    expect(a[4]).toBe(0);
  });
});

describe("floodRegion", () => {
  const { rgba, w, h } = image([".....", ".###.", ".#.#.", ".###.", "....."]);
  const dark = computeDarkness(rgba);

  it("線で囲まれた中は外と分かれる", () => {
    const inner = floodRegion(dark, w, h, 128, 2, 2);
    expect([...inner]).toEqual([2 * w + 2]);
    const outer = floodRegion(dark, w, h, 128, 0, 0);
    expect(outer.length).toBe(w * h - 8 - 1);
    expect(outer).not.toContain(2 * w + 2);
  });
  it("線の上や範囲外は空", () => {
    expect(floodRegion(dark, w, h, 128, 1, 1).length).toBe(0);
    expect(floodRegion(dark, w, h, 128, -1, 0).length).toBe(0);
    expect(floodRegion(dark, w, h, 128, 5, 0).length).toBe(0);
  });
  it("線が途切れていると中と外がつながる", () => {
    const gap = image([".....", ".###.", ".#...", ".###.", "....."]);
    const region = floodRegion(computeDarkness(gap.rgba), gap.w, gap.h, 128, 2, 2);
    expect(region.length).toBe(gap.w * gap.h - 7);
  });
  it("色のついた線は黒ではないので塗れる側になる", () => {
    const col = image(["r.", ".."]);
    const region = floodRegion(computeDarkness(col.rgba), col.w, col.h, 128, 0, 0);
    expect(region.length).toBe(4);
  });
});

describe("compose", () => {
  it("線のない画素は塗った色、完全な線は黒", () => {
    const colors = Uint8ClampedArray.from([10, 20, 30, 255, 10, 20, 30, 255]);
    const out = new Uint8ClampedArray(8);
    compose(colors, Uint8Array.from([0, 255]), out);
    expect([...out]).toEqual([10, 20, 30, 255, 0, 0, 0, 255]);
  });
});

describe("色の変換", () => {
  it("16進数", () => {
    expect(parseHex("#ff8000")).toEqual([255, 128, 0]);
    expect(parseHex("f80")).toEqual([255, 136, 0]);
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("xyz")).toBeNull();
    expect(toHex([255, 128, 0])).toBe("#ff8000");
    expect(toHex([0, 0, 0])).toBe("#000000");
  });
  it("チャンネルは 0〜255 に丸める", () => {
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(-5)).toBe(0);
    expect(clampChannel(12.6)).toBe(13);
    expect(clampChannel(NaN)).toBe(0);
  });
});

describe("fitSize", () => {
  it("長辺が上限以下ならそのまま、超えたら比を保って縮める", () => {
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitSize(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
  });
});
