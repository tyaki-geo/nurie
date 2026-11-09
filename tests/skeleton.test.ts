import { describe, expect, it } from "vitest";
import { distanceTransform, ridgeOf, snapToRidge } from "../src/lib/skeleton";

function mask(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0]!.length;
  const m = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (m[y * w + x] = c === "#" ? 1 : 0)));
  return { m, w, h };
}

describe("distanceTransform", () => {
  it("元の画素からの距離", () => {
    const { m, w, h } = mask(["#....", ".....", "....."]);
    const d = distanceTransform(m, w, h);
    expect(d[0]).toBe(0);
    expect(d[4]).toBeCloseTo(4);
    expect(d[1 * w + 1]).toBeCloseTo(Math.SQRT2);
  });
  it("元がなければ Infinity", () => {
    expect(distanceTransform(new Uint8Array(4), 2, 2)[0]).toBe(Infinity);
  });
});

describe("ridgeOf", () => {
  it("太い線の芯は中央の筋", () => {
    const { m, w, h } = mask([
      ".........",
      "#########",
      "#########",
      "#########",
      "#########",
      "#########",
      ".........",
    ]);
    const r = ridgeOf(m, w, h);
    expect(r[3 * w + 4]).toBe(1); // 中央の行
    expect(r[1 * w + 4]).toBe(0); // 縁
  });
  it("1 画素の線は線そのものが芯", () => {
    const { m, w, h } = mask(["...", "###", "..."]);
    const r = ridgeOf(m, w, h);
    expect([...r]).toEqual([...m]);
  });
});

describe("snapToRidge", () => {
  const { m, w, h } = mask([
    "..........",
    "##########",
    "..........",
    "..........",
    "..........",
    "##########",
    "..........",
  ]);
  it("もっとも近い芯の中心に吸着する", () => {
    const p = snapToRidge(m, w, h, 4.2, 3.0, 5);
    // 距離は上の線 (1.5) が下 (2.5) より近い
    expect(p!.y).toBe(1.5);
  });
  it("半径内に芯がなければ null", () => {
    expect(snapToRidge(m, w, h, 4, 3, 1)).toBeNull();
  });
  it("直前の吸着先に近い線を少し優先する", () => {
    // 2本の線のほぼ中間（やや下の線寄り）でも、いま上の線にいれば上の線に残る
    const p = snapToRidge(m, w, h, 4.5, 3.6, 5, { x: 4.5, y: 1.5 });
    expect(p!.y).toBe(1.5);
  });
});
