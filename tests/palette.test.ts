import { describe, expect, it } from "vitest";
import { PALETTE } from "../src/lib/palette";
import { parseHex } from "../src/lib/lineart";

describe("PALETTE", () => {
  it("24色で、名前も色も重複せず、すべて不透明な色として読める", () => {
    expect(PALETTE.length).toBe(24);
    expect(new Set(PALETTE.map((c) => c.name)).size).toBe(24);
    expect(new Set(PALETTE.map((c) => c.hex)).size).toBe(24);
    for (const c of PALETTE) expect(parseHex(c.hex)?.[3]).toBe(255);
  });
});
