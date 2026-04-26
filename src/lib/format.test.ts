import { describe, expect, it } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("formats milliseconds to m:ss", () => {
    expect(formatDuration(215000)).toBe("3:35");
  });
});
