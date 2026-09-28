import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The fixture derives its directory from import.meta.url. Load the actual source in a temporary
// web/e2e/fixtures tree so this test never touches a browser run's real bundles or lock.
test("only the swap-server owner clears directives, before releasing its lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "collie-swap-lock-"));
  try {
    const fixtures = join(root, "web", "e2e", "fixtures");
    mkdirSync(fixtures, { recursive: true });
    const copy = join(fixtures, "builds.ts");
    writeFileSync(copy, readFileSync(join(import.meta.dir, "..", "web", "e2e", "fixtures", "builds.ts")));
    const builds: typeof import("../web/e2e/fixtures/builds.ts") = await import(pathToFileURL(copy).href);
    const lock = join(builds.BUILDS_DIR, "lock");
    mkdirSync(builds.BUILDS_DIR, { recursive: true });
    const owner = join(lock, "pid");
    await builds.holdSwapServer();
    const delay = { match: "/probe", ms: 1234 };
    const fail = { match: "/probe", status: 503, times: 2 };
    const throttle = { match: "/probe", bytesPerSecond: 1234 };
    builds.setDelay(delay);
    builds.setFail(fail);
    builds.setThrottle(throttle);

    // Another owner may neither overwrite nor clear directives, nor release the lock.
    writeFileSync(owner, String(process.pid + 1));
    for (const write of [
      () => builds.serveBuild("b"),
      () => builds.setDelay(delay), () => builds.clearDelay(),
      () => builds.setFail(fail), () => builds.clearFail(),
      () => builds.setThrottle(throttle), () => builds.clearThrottle(),
    ]) expect(write).toThrow("without the swap server's lock");
    builds.releaseSwapServer();
    expect(builds.readDelay()).toEqual(delay);
    expect(builds.readFail()).toEqual(fail);
    expect(builds.readThrottle()).toEqual(throttle);
    expect(existsSync(lock)).toBe(true);

    writeFileSync(owner, String(process.pid));
    builds.releaseSwapServer();
    expect(builds.readDelay()).toBeUndefined();
    expect(builds.readFail()).toBeUndefined();
    expect(builds.readThrottle()).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(() => builds.releaseSwapServer()).not.toThrow();
    expect(() => builds.setDelay(delay)).toThrow("without the swap server's lock");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
