import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise only refused startup with fake executables and a scratch HOME/TMPDIR. The fake Herdr
// always reports an existing session and refuses every other command. No agent can be launched.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "collie-canary-safety-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const project = join(root, "collie-canary-project");
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  writeFileSync(join(bin, "herdr"), `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
if (process.argv.slice(2).join(" ") !== "session list --json") process.exit(99);
writeFileSync(process.env.TMPDIR + "/listed", "yes");
while (process.env.FAKE_HOLD === "1" && existsSync(process.env.TMPDIR + "/hold")) await Bun.sleep(10);
console.log(JSON.stringify({sessions: [{name: "collie-canary", running: true, socket_path: "/fake-only"}]}));
`, { mode: 0o700 });
  const start = (keep = false, hold = false) => Bun.spawn([
    process.execPath, join(import.meta.dir, "run.ts"), "--out", join(root, "out"), ...(keep ? ["--keep"] : []),
  ], {
    cwd: join(import.meta.dir, "../.."),
    env: { PATH: bin, HOME: root, TMPDIR: root, FAKE_HOLD: hold ? "1" : "0" },
    stdout: "pipe", stderr: "pipe", timeout: 4000,
  });
  return { root, project, start };
}

for (const keep of [false, true]) {
  test(`a refused launch preserves another run's project (keep=${keep})`, async () => {
    const { project, start } = sandbox();
    mkdirSync(project);
    writeFileSync(join(project, "owned"), "prior run bytes");
    const child = start(keep);
    expect(await child.exited).not.toBe(0);
    expect(existsSync(join(project, "owned"))).toBe(true);
    expect(readFileSync(join(project, "owned"), "utf8")).toBe("prior run bytes");
  });
}

test("--keep does not retain a project when session ownership was refused", async () => {
  const { project, start } = sandbox();
  const child = start(true);
  expect(await child.exited).not.toBe(0);
  expect(existsSync(project)).toBe(false);
});

test("concurrent refused startup cannot replace or clean the first launch's project", async () => {
  const { root, project, start } = sandbox();
  const hold = join(root, "hold");
  writeFileSync(hold, "hold fake session listing");
  const first = start(false, true);
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(join(root, "listed")) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(join(root, "listed"))).toBe(true);
    writeFileSync(join(project, "owned"), "first launch bytes");
    const second = start();
    // Stop holding by renaming rather than deleting scratch evidence.
    const { renameSync } = await import("node:fs");
    // Only the first fake listing is held. Even if the second wrongly reaches Herdr, it returns
    // immediately, so preservation is checked while the first launch still owns its project.
    const result = await second.exited;
    const preserved = existsSync(join(project, "owned"));
    renameSync(hold, join(root, "hold-released"));
    expect(result).not.toBe(0);
    expect(await first.exited).not.toBe(0);
    expect(preserved).toBe(true);
    expect(existsSync(project)).toBe(false);
  } finally {
    first.kill();
  }
});
