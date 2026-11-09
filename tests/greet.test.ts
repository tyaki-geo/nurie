import { describe, expect, it } from "vitest";
import { greet } from "../src/lib/greet";

describe("greet", () => {
  it("名前を入れた挨拶を返す", () => {
    expect(greet("world")).toBe("Hello, world!");
  });
});
