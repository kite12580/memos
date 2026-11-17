import { describe, expect, it, vi } from "vitest";
import { memoizeByText } from "@/lib/memoize-by-text";

describe("memoizeByText", () => {
  it("computes each text once and keeps the texts read most recently", () => {
    const compute = vi.fn((text: string) => ({ text }));
    const memoized = memoizeByText(compute, 2);

    const first = memoized("a");
    expect(memoized("a")).toBe(first);
    memoized("b");
    memoized("a");
    memoized("c");
    expect(compute).toHaveBeenCalledTimes(3);

    expect(memoized("a")).toBe(first);
    memoized("b");
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it("computes again after clear", () => {
    const compute = vi.fn((text: string) => text.length);
    const memoized = memoizeByText(compute, 4);
    memoized("a");
    memoized.clear();
    memoized("a");
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
