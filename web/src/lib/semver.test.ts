import { describe, expect, it } from "vitest";
import { bareVersion, crossesMajor } from "./semver";

it("normalizes a directory name without losing its prerelease or fork metadata", () => {
  expect(bareVersion(" v2.0.0-rc.1+ys.2 ")).toBe("2.0.0-rc.1+ys.2");
  expect(bareVersion("1.13.1+ys.2")).toBe("1.13.1+ys.2");
});

describe("major-upgrade consent", () => {
  it.each([
    ["1.13.1+ys.1", "2.0.0+ys.1", true],
    ["1.13.1+ys.1", "1.13.1+ys.2", false],
    ["0.9.0", "1.0.0", true],
    ["2.0.0", "1.13.1", false],
    ["1.0.0-rc.1", "1.0.0", false],
    [" 1.13.1-dev+ys.1 ", " 2.0.0+ys.1 ", true],
    ["v1.13.1+ys.1", "1.13.1+ys.2", false],
    ["v1.13.1+ys.1", "v2.0.0+ys.1", true],
  ])("%s to %s crosses a major: %s", (current, target, expected) => {
    expect(crossesMajor(current, target)).toBe(expected);
  });
});
