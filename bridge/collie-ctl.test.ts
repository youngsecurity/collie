import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("status probes and displays the configured bridge host", async () => {
  const configuredHost = "127.0.0.2";
  const configDir = await mkdtemp(join(tmpdir(), "collie-ctl-test-"));
  const server = Bun.listen({
    hostname: configuredHost,
    port: 0,
    socket: {
      data() {},
    },
  });

  try {
    const proc = Bun.spawn({
      cmd: ["bash", "scripts/collie-ctl.sh", "status"],
      cwd: ROOT,
      env: {
        ...process.env,
        COLLIE_HOST: configuredHost,
        COLLIE_PORT: String(server.port),
        COLLIE_SKIP_SERVE: "1",
        HERDR_PLUGIN_CONFIG_DIR: configDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("✓ Collie is running");
    expect(stdout).toContain(`local     http://${configuredHost}:${server.port}`);
  } finally {
    server.stop(true);
    await rm(configDir, { recursive: true, force: true });
  }
}, 10_000);
