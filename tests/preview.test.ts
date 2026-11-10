import { describe, expect, it } from "vitest";
import { DEFAULT_SPAN, MAX_SPAN, MIN_SPAN, spanScale, zoomSpan } from "../src/lib/preview";

describe("zoomSpan", () => {
  it("上に回す（deltaY < 0）と span が小さくなる（拡大）", () => {
    expect(zoomSpan(DEFAULT_SPAN, -100)).toBeLessThan(DEFAULT_SPAN);
  });
  it("下に回す（deltaY > 0）と span が大きくなる（縮小）", () => {
    expect(zoomSpan(DEFAULT_SPAN, 100)).toBeGreaterThan(DEFAULT_SPAN);
  });
  it("回さなければ変わらない", () => {
    expect(zoomSpan(DEFAULT_SPAN, 0)).toBe(DEFAULT_SPAN);
  });
  it("範囲の外には出ない", () => {
    expect(zoomSpan(MIN_SPAN, -10000)).toBe(MIN_SPAN);
    expect(zoomSpan(MAX_SPAN, 10000)).toBe(MAX_SPAN);
  });
  it("往復すると元に戻る", () => {
    expect(zoomSpan(zoomSpan(DEFAULT_SPAN, -120), 120)).toBeCloseTo(DEFAULT_SPAN, 9);
  });
});

describe("spanScale", () => {
  it("初期は 1 倍、span が半分なら 2 倍", () => {
    expect(spanScale(DEFAULT_SPAN)).toBe(1);
    expect(spanScale(DEFAULT_SPAN / 2)).toBe(2);
  });
});
