import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise only refused startup with fake executables and a scratch home and temp directory. The fake Herdr
// always reports an existing session and refuses every other command. No agent can be launched.
function sandbox() {
  // Spaces also exercise quoting in the Windows command wrappers.
  const root = mkdtempSync(join(tmpdir(), "collie canary safety-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const project = join(root, "collie-canary-project");
  const fakeExecutable = (name: string, source: string) => {
    if (process.platform === "win32") {
      // Windows cannot execute an extensionless shebang file. Keep PATH sandbox-only:
      // each command wrapper invokes this Bun by its absolute, quoted path.
      writeFileSync(join(bin, `${name}.js`), source);
      writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
    }
  };
  fakeExecutable("git", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TMPDIR + "/git-calls", process.argv.slice(2).join(" ") + "\\n");
`);
  fakeExecutable("herdr", `
import { existsSync, writeFileSync } from "node:fs";
if (process.argv.slice(2).join(" ") !== "session list --json") process.exit(99);
writeFileSync(process.env.TMPDIR + "/listed", "yes");
while (process.env.FAKE_HOLD === "1" && existsSync(process.env.TMPDIR + "/hold")) await Bun.sleep(10);
console.log(JSON.stringify({sessions: [{name: "collie-canary", running: true, socket_path: "/fake-only"}]}));
`);
  const start = (keep = false, hold = false) => Bun.spawn([
    process.execPath, join(import.meta.dir, "run.ts"), "--out", join(root, "out"), ...(keep ? ["--keep"] : []),
  ], {
    cwd: join(import.meta.dir, "../.."),
    env: { PATH: bin, HOME: root, TEMP: root, TMP: root, TMPDIR: root, FAKE_HOLD: hold ? "1" : "0" },
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
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toContain(`cannot acquire canary project ${project}`);
    expect(existsSync(join(project, "owned"))).toBe(true);
    expect(readFileSync(join(project, "owned"), "utf8")).toBe("prior run bytes");
  });
}

test("--keep does not retain a project when session ownership was refused", async () => {
  const { root, project, start } = sandbox();
  const child = start(true);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("a Herdr session named collie-canary already exists");
  // A generic nonzero exit would also pass for a missing executable. Prove both fakes ran.
  expect(readFileSync(join(root, "git-calls"), "utf8").trim().split("\n")).toEqual(
    ["init -q", "add README.md", "commit -q -m canary"].map(
      (args) => `-c user.name=collie-canary -c user.email=canary@invalid ${args}`,
    ),
  );
  expect(readFileSync(join(root, "listed"), "utf8")).toBe("yes");
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
    const preserved = readFileSync(join(project, "owned"), "utf8");
    renameSync(hold, join(root, "hold-released"));
    expect(result).toBe(1);
    expect(await new Response(second.stderr).text()).toContain(`cannot acquire canary project ${project}`);
    expect(await first.exited).toBe(1);
    expect(await new Response(first.stderr).text()).toContain("a Herdr session named collie-canary already exists");
    expect(preserved).toBe("first launch bytes");
    expect(existsSync(project)).toBe(false);
  } finally {
    first.kill();
  }
});
