import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

test("status parses the Tailscale DNS name with Bun and does not require Node", async () => {
  const configuredHost = "127.0.0.2";
  const configDir = await mkdtemp(join(tmpdir(), "collie-ctl-config-test-"));
  const binDir = await mkdtemp(join(tmpdir(), "collie-ctl-bin-test-"));
  const server = Bun.listen({
    hostname: configuredHost,
    port: 0,
    socket: {
      data() {},
    },
  });

  try {
    const tailscalePath = join(binDir, "tailscale");
    const nodePath = join(binDir, "node");
    await writeFile(
      tailscalePath,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"Self":{"DNSName":"carl.tail-example.ts.net."}}'\n`,
    );
    await writeFile(nodePath, "#!/usr/bin/env bash\nexit 99\n");
    await Promise.all([chmod(tailscalePath, 0o755), chmod(nodePath, 0o755)]);

    const proc = Bun.spawn({
      cmd: ["bash", "scripts/collie-ctl.sh", "status"],
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        COLLIE_HOST: configuredHost,
        COLLIE_PORT: String(server.port),
        COLLIE_SERVE_MODE: "https",
        COLLIE_SKIP_SERVE: "0",
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
    expect(stdout).toContain("tailnet   https://carl.tail-example.ts.net");
  } finally {
    server.stop(true);
    await Promise.all([
      rm(configDir, { recursive: true, force: true }),
      rm(binDir, { recursive: true, force: true }),
    ]);
  }
}, 10_000);
