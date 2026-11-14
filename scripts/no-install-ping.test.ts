import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_SETTINGS } from "../bridge/config-schema.ts";

// This fork sends nothing about an install (ADR 0034). Upstream 1.27.0 added an anonymous daily
// install ping, on by default, and a count of trouble cards that rides on it. The fork
// removes both, and every upstream merge can bring them back: a merge that restores the module, the
// route or the setting passes typecheck and every other test. This file is what fails.

const ROOT = join(import.meta.dir, "..");

// Joined from parts so this file is not a hit for its own search.
const PING_HOST = ["ping", "colliepwa", "dev"].join(".");
const PING_AGENT = ["collie", "ping"].join("-");

/** The files of `files`, under `root`, that name the ping's receiver or its User-Agent. */
function pingHits(root: string, files: readonly string[]): string[] {
  return files.filter((file) => {
    const text = readFileSync(join(root, file), "latin1");
    return text.includes(PING_HOST) || text.includes(PING_AGENT);
  });
}

/** Every file git tracks. Untracked work (a plan, a build) is not the source and is not read. */
function trackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  return out.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)));
}

describe("the install ping is not in this fork", () => {
  // CLAUDE.md asks a pattern-matching guard for a planted violation in scope and a control out of
  // it: a search that matches nothing passes everything.
  test("the search finds a planted receiver and a planted User-Agent, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "collie-no-ping-"));
    try {
      writeFileSync(join(dir, "receiver.ts"), `export const URL = "https://${PING_HOST}/v1/ping";\n`);
      writeFileSync(join(dir, "agent.ts"), `headers: { "User-Agent": "${PING_AGENT}" }\n`);
      // The site's own host and the update check's User-Agent are not the ping.
      writeFileSync(join(dir, "install.md"), "curl -fsSL https://colliepwa.dev/install.sh | sh\n");
      writeFileSync(join(dir, "update.ts"), `headers: { "User-Agent": "collie-update-check" }\n`);
      expect(pingHits(dir, ["receiver.ts", "agent.ts", "install.md", "update.ts"])).toEqual(["receiver.ts", "agent.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no tracked file names the ping's receiver or its User-Agent", () => {
    const files = trackedFiles();
    // A checkout without git would list nothing and pass; this repository tracks thousands.
    expect(files.length).toBeGreaterThan(1000);
    expect(pingHits(ROOT, files)).toEqual([]);
  });

  test("the module, its receiver contract and its two decision records are gone", () => {
    const files = trackedFiles();
    expect(files.filter((file) => file === "bridge/telemetry.ts" || file.startsWith("telemetry/"))).toEqual([]);
    expect(files.filter((file) => /^\.adr\/(?:0129|0134)-/.test(file))).toEqual([]);
    expect(files.filter((file) => /(?:^|\/)telemetry-(?:notice|settings-card)\./.test(file))).toEqual([]);
  });

  test("the bridge serves no telemetry route and reads no telemetry setting", () => {
    expect(readFileSync(join(ROOT, "bridge", "server.ts"), "utf8")).not.toContain("/api/telemetry");
    expect(readFileSync(join(ROOT, "bridge", "index.ts"), "utf8").toLowerCase()).not.toContain("telemetry");
    expect(readFileSync(join(ROOT, "web", "src", "lib", "api.ts"), "utf8")).not.toContain("/api/telemetry");
    const settings = CONFIG_SETTINGS.filter((setting) => /telemetry/i.test(setting.key) || /TELEMETRY/.test(setting.env));
    expect(settings.map((setting) => setting.key)).toEqual([]);
  });
});
