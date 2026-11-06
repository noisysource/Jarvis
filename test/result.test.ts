import { describe, expect, expectTypeOf, it } from "vitest";
import { err, ok, type Result } from "../src/result.js";

describe("Result", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("err wraps an error", () => {
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });

  it("narrows on the ok flag", () => {
    const parse = (s: string): Result<number> => {
      const n = Number(s);
      return Number.isNaN(n) ? err(`not a number: ${s}`) : ok(n);
    };

    const good = parse("7");
    const bad = parse("x");

    expect(good.ok && good.value).toBe(7);
    expect(!bad.ok && bad.error).toBe("not a number: x");

    if (good.ok) {
      expectTypeOf(good.value).toEqualTypeOf<number>();
    } else {
      expectTypeOf(good.error).toEqualTypeOf<string>();
    }
  });
});
