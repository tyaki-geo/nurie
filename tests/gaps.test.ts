import { describe, expect, it } from "vitest";
import { computeDarkness } from "../src/lib/lineart";
import { analyzeGaps, resolveGaps } from "../src/lib/gaps";
import { labelRegions } from "../src/lib/regions";

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

/** 2 つの部屋（各 8×8）の間の仕切りに、1 マス分の隙間がある */
function twoRoomsWithGap(gapRows: number[]): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 12; y++) {
    if (y === 0 || y === 11) {
      rows.push("#".repeat(21));
      continue;
    }
    const mid = gapRows.includes(y) ? "." : "#";
    rows.push("#" + ".".repeat(9) + mid + ".".repeat(9) + "#");
  }
  return rows;
}

describe("analyzeGaps", () => {
  const { dark, w, h } = darkOf(twoRoomsWithGap([5]));
  const base = labelRegions(dark, w, h, 128);

  it("隙間があると、元の検出では1つにつながる", () => {
    expect(base.count).toBe(1);
  });

  it("隙間の候補を見つけ、囲まれ具合が高い", () => {
    const a = analyzeGaps(base, w, h, { maxWidth: 3, minEnclosure: 0.8, minSeedSize: 4 });
    expect(a.candidates).toHaveLength(1);
    const c = a.candidates[0]!;
    expect(c.enclosure).toBeGreaterThan(0.9);
    expect(c.x).toBeGreaterThan(8);
    expect(c.x).toBeLessThan(12);
  });

  it("別々にすると2つの領域、同じにすると1つの領域", () => {
    const a = analyzeGaps(base, w, h, { maxWidth: 3, minEnclosure: 0.8, minSeedSize: 4 });
    const split = resolveGaps(a, new Set(), w, h);
    expect(split.count).toBe(2);
    expect(split.labels[5 * w + 3]).toBe(1);
    expect(split.labels[5 * w + 17]).toBe(2);
    const same = resolveGaps(a, new Set([1]), w, h);
    expect(same.count).toBe(1);
  });

  it("切り口は隙間をまたぐ（隙間の画素はどちらかに属す）", () => {
    const a = analyzeGaps(base, w, h, { maxWidth: 3, minEnclosure: 0.8, minSeedSize: 4 });
    const split = resolveGaps(a, new Set(), w, h);
    expect(split.labels[5 * w + 10]).toBeGreaterThan(0);
  });

  it("隙間が最大幅より広ければふさがらず、候補にならない", () => {
    const wide = darkOf(twoRoomsWithGap([4, 5, 6, 7, 8]));
    const b = labelRegions(wide.dark, wide.w, wide.h, 128);
    const a = analyzeGaps(b, wide.w, wide.h, { maxWidth: 2, minEnclosure: 0.8, minSeedSize: 4 });
    expect(a.candidates).toHaveLength(0);
    expect(resolveGaps(a, new Set(), wide.w, wide.h).count).toBe(1);
  });

  it("囲まれ具合が下限に満たない広い通路は、同じ領域のまま", () => {
    const door = darkOf(twoRoomsWithGap([3, 4, 5, 6, 7, 8]));
    const b = labelRegions(door.dark, door.w, door.h, 128);
    const a = analyzeGaps(b, door.w, door.h, { maxWidth: 8, minEnclosure: 0.95, minSeedSize: 4 });
    expect(a.candidates).toHaveLength(0);
    expect(resolveGaps(a, new Set(), door.w, door.h).count).toBe(1);
  });

  it("隙間がなければ、元の領域と同じ", () => {
    const closed = darkOf(twoRoomsWithGap([]));
    const b = labelRegions(closed.dark, closed.w, closed.h, 128);
    const a = analyzeGaps(b, closed.w, closed.h, { maxWidth: 3, minEnclosure: 0.8, minSeedSize: 4 });
    expect(a.candidates).toHaveLength(0);
    const r = resolveGaps(a, new Set(), closed.w, closed.h);
    expect(r.count).toBe(b.count);
    expect([...r.labels]).toEqual([...b.labels]);
  });

  it("細くて部屋ができない領域も、消えずに残る", () => {
    const thin = darkOf(["#####", "#...#", "#####"]);
    const b = labelRegions(thin.dark, thin.w, thin.h, 128);
    const a = analyzeGaps(b, thin.w, thin.h, { maxWidth: 6, minEnclosure: 0.8, minSeedSize: 4 });
    expect(resolveGaps(a, new Set(), thin.w, thin.h).count).toBe(1);
  });
});
