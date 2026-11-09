import { describe, expect, it } from "vitest";
import {
  channelBalance,
  clampChannel,
  compose,
  computeDarkness,
  darkness,
  fillColor,
  fitSize,
  floodRegion,
  lineAlpha,
  parseHex,
  toCss,
  toHex,
  toHex6,
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
  const black = Uint8ClampedArray.from([0, 0, 0, 255, 0, 0, 0, 255]);

  it("線のない画素は塗った色、完全な線は線の色（黒）", () => {
    const colors = Uint8ClampedArray.from([10, 20, 30, 255, 10, 20, 30, 255]);
    const out = new Uint8ClampedArray(8);
    compose(colors, black, Uint8Array.from([0, 255]), out);
    expect([...out]).toEqual([10, 20, 30, 255, 0, 0, 0, 255]);
  });
  it("線の色を変えると、その色で線が出る", () => {
    const colors = new Uint8ClampedArray(8).fill(255);
    const red = Uint8ClampedArray.from([255, 0, 0, 255, 255, 0, 0, 255]);
    const out = new Uint8ClampedArray(8);
    compose(colors, red, Uint8Array.from([0, 255]), out);
    expect([...out]).toEqual([255, 255, 255, 255, 255, 0, 0, 255]);
  });
  it("塗った色が半透明なら出力も半透明（色はそのまま）", () => {
    const colors = Uint8ClampedArray.from([10, 20, 30, 128, 10, 20, 30, 0]);
    const out = new Uint8ClampedArray(8);
    compose(colors, black, Uint8Array.from([0, 0]), out);
    expect([...out]).toEqual([10, 20, 30, 128, 0, 0, 0, 0]);
  });
  it("半透明の線は塗った色と混ざる", () => {
    const colors = Uint8ClampedArray.from([200, 200, 200, 255]);
    const out = new Uint8ClampedArray(4);
    compose(colors, Uint8ClampedArray.from([0, 0, 0, 255]), Uint8Array.from([128]), out);
    expect(out[0]).toBeGreaterThan(90);
    expect(out[0]).toBeLessThan(110);
    expect(out[3]).toBe(255);
  });
  it("線の色が半透明なら線の濃さに掛かる", () => {
    const colors = Uint8ClampedArray.from([200, 200, 200, 255]);
    const out = new Uint8ClampedArray(4);
    compose(colors, Uint8ClampedArray.from([0, 0, 0, 0]), Uint8Array.from([255]), out);
    expect([...out]).toEqual([200, 200, 200, 255]);
  });
  it("範囲を指定すると、その画素だけ更新する", () => {
    const colors = new Uint8ClampedArray(8).fill(255);
    const out = new Uint8ClampedArray(8);
    compose(colors, black, Uint8Array.from([0, 0]), out, 1, 2);
    expect([...out]).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
  });
});

describe("fillColor", () => {
  it("配列を指定の色で埋める", () => {
    const buf = new Uint8ClampedArray(8);
    fillColor(buf, [1, 2, 3, 4]);
    expect([...buf]).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });
});

describe("色の変換", () => {
  it("16進数（不透明度つき）", () => {
    expect(parseHex("#ff8000")).toEqual([255, 128, 0, 255]);
    expect(parseHex("#ff800080")).toEqual([255, 128, 0, 128]);
    expect(parseHex("f80")).toEqual([255, 136, 0, 255]);
    expect(parseHex("f808")).toEqual([255, 136, 0, 136]);
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("xyz")).toBeNull();
    expect(toHex([255, 128, 0, 255])).toBe("#ff8000");
    expect(toHex([255, 128, 0, 128])).toBe("#ff800080");
    expect(toHex([0, 0, 0])).toBe("#000000");
    expect(toHex6([255, 128, 0, 10])).toBe("#ff8000");
    expect(toHex(Uint8ClampedArray.from([1, 2, 3, 255]).subarray(0, 4))).toBe("#010203");
  });
  it("CSS の色", () => {
    expect(toCss([255, 0, 0, 255])).toBe("rgba(255, 0, 0, 1.000)");
    expect(toCss([0, 0, 0, 0])).toBe("rgba(0, 0, 0, 0.000)");
  });
  it("チャンネルは 0〜255 に丸める", () => {
    expect(clampChannel(300)).toBe(255);
    expect(clampChannel(-5)).toBe(0);
    expect(clampChannel(12.6)).toBe(13);
    expect(clampChannel(NaN)).toBe(0);
  });
});

describe("channelBalance", () => {
  it("R・G・B は合計に対する割合、A は不透明度の%", () => {
    expect(channelBalance([200, 100, 100, 255])).toEqual({ r: 50, g: 25, b: 25, a: 100 });
    expect(channelBalance([255, 0, 0, 128])).toEqual({ r: 100, g: 0, b: 0, a: 50.2 });
  });
  it("黒は割合を出せないので 0", () => {
    expect(channelBalance([0, 0, 0, 255])).toEqual({ r: 0, g: 0, b: 0, a: 100 });
  });
});

describe("fitSize", () => {
  it("長辺が上限以下ならそのまま、超えたら比を保って縮める", () => {
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitSize(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 });
  });
});
