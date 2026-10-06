import { describe, expect, test } from "bun:test";

import { hostFor } from "../bridge/host.ts";
import { fakeFiles, posixKey } from "./fakes.ts";

describe("posixKey", () => {
  test("folds a Windows path to the POSIX key a fake filesystem stores", () => {
    expect(posixKey("C:\\opt\\collie\\bin\\collie.exe", hostFor("win32"))).toBe("/opt/collie/bin/collie.exe");
    expect(posixKey("\\opt\\collie", hostFor("win32"))).toBe("/opt/collie");
  });

  test("without a host it folds, so a Windows host pinned on Linux still finds its files", () => {
    expect(posixKey("C:\\opt\\collie")).toBe("/opt/collie");
    expect(posixKey("/opt/collie")).toBe("/opt/collie");
  });

  test("leaves a path alone off Windows, where a backslash is a legal name character", () => {
    expect(posixKey("/opt/co\\llie", hostFor("linux"))).toBe("/opt/co\\llie");
  });
});

describe("fakeFiles", () => {
  test("exclusive locks share path folding and preserve their creation time", () => {
    const files = fakeFiles();
    const windows = "C:\\state\\update.lock";
    expect(files.createExclusive(windows, "owner", 0o600)).toBe(true);
    expect(files.read("/state/update.lock")).toBe("owner");
    expect(files.mtimeMs(windows)).toBe(files.clock.now);
    files.clock.now += 100;
    expect(files.createExclusive("/state/update.lock", "other", 0o600)).toBe(false);
    expect(files.mtimeMs("/state/update.lock")).toBe(files.clock.now - 100);
    files.remove(windows);
    expect(files.mtimeMs(windows)).toBeNull();
    expect(files.locks).toEqual(["lock /state/update.lock", "unlock /state/update.lock"]);
  });

  test("answers a path seeded by its POSIX key", () => {
    const files = fakeFiles({ "/opt/collie/VERSION": "1.0.0\n" });
    expect(files.read("/opt/collie/VERSION")).toBe("1.0.0\n");
    expect(files.exists("/opt/collie")).toBe(true);
  });
});
