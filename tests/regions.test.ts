import { describe, expect, it } from "vitest";
import { computeDarkness } from "../src/lib/lineart";
import { formatRegionList, labelRegions, parseRegionList, pixelsOf } from "../src/lib/regions";

/** # = 黒、. = 白 */
function darkOf(rows: string[]): { dark: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => rgba.set(ch === "#" ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * w + x) * 4)),
  );
  return { dark: computeDarkness(rgba), w, h };
}

describe("labelRegions", () => {
  // 外側 / 左の部屋 / 右の部屋
  const { dark, w, h } = darkOf([
    "#########",
    "#...#...#",
    "#...#...#",
    "#########",
  ]);

  it("線で囲まれた領域に、左上から順に番号がつく", () => {
    const r = labelRegions(dark, w, h, 128);
    expect(r.count).toBe(2);
    expect(r.labels[1 * w + 1]).toBe(1); // 左の部屋
    expect(r.labels[1 * w + 5]).toBe(2); // 右の部屋
    expect(r.labels[0]).toBe(0); // 線の上は 0
    expect([...r.sizes]).toEqual([0, 6, 6]);
  });
  it("外側が線で囲まれていなければ外側にも番号がつく", () => {
    const g = darkOf(["....", ".##.", ".##.", "...."]);
    const r = labelRegions(g.dark, g.w, g.h, 128);
    expect(r.count).toBe(1);
    expect(r.sizes[1]).toBe(12);
  });
  it("同じ入力なら番号は同じ", () => {
    const a = labelRegions(dark, w, h, 128);
    const b = labelRegions(dark, w, h, 128);
    expect([...a.labels]).toEqual([...b.labels]);
  });
  it("線が途切れていれば1つの領域", () => {
    const g = darkOf(["#########", "#...#...#", "#.......#", "#########"]);
    expect(labelRegions(g.dark, g.w, g.h, 128).count).toBe(1);
  });
  it("番号の位置は領域の中にある（C 字型でも）", () => {
    const g = darkOf(["#######", "#.....#", "#.###.#", "#.#.#.#", "#.#.#.#", "#######"]);
    const r = labelRegions(g.dark, g.w, g.h, 128);
    for (let id = 1; id <= r.count; id++) {
      expect(r.labels[r.anchors[id]!]).toBe(id);
    }
  });
});

describe("番号の位置", () => {
  it("輪の外側のように重心が領域の外でも、重心に近い位置に置く（画像の隅にしない）", () => {
    const g = darkOf([
      ".........",
      ".#######.",
      ".#.....#.",
      ".#.....#.",
      ".#.....#.",
      ".#######.",
      ".........",
    ]);
    const r = labelRegions(g.dark, g.w, g.h, 128);
    expect(r.count).toBe(2);
    const outer = r.labels[0]!; // 隅の画素が属する領域 = 外側
    const a = r.anchors[outer]!;
    expect(r.labels[a]).toBe(outer);
    expect(a).not.toBe(0); // 左上隅ではない
    const x = a % g.w;
    const y = Math.floor(a / g.w);
    // 中心 (4, 3) からいちばん近い外側の画素は、枠のすぐ外
    expect(Math.hypot(x - 4, y - 3)).toBeLessThanOrEqual(4);
  });
});

describe("pixelsOf", () => {
  it("指定した領域の画素だけ集める", () => {
    const labels = Int32Array.from([0, 1, 2, 1, 3]);
    expect([...pixelsOf(labels, new Set([1, 3]))]).toEqual([1, 3, 4]);
  });
});

describe("parseRegionList / formatRegionList", () => {
  it("番号と範囲を読む", () => {
    expect(parseRegionList("1, 3, 5-7", 10)).toEqual({ ids: [1, 3, 5, 6, 7], ignored: [] });
    expect(parseRegionList("2〜4 9", 10).ids).toEqual([2, 3, 4, 9]);
    expect(parseRegionList("7-5", 10).ids).toEqual([5, 6, 7]);
  });
  it("範囲外・読めない部分は無視して知らせる", () => {
    const r = parseRegionList("0, 3, 99, abc, 8-20", 10);
    expect(r.ids).toEqual([3, 8, 9, 10]);
    expect(r.ignored).toEqual(["0", "99", "abc"]);
  });
  it("空なら空", () => {
    expect(parseRegionList("  ", 10)).toEqual({ ids: [], ignored: [] });
  });
  it("短い表記にする", () => {
    expect(formatRegionList([7, 1, 2, 3, 5, 5])).toBe("1-3, 5, 7");
    expect(formatRegionList([1, 2])).toBe("1, 2");
    expect(formatRegionList([])).toBe("");
  });
});
