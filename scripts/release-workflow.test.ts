import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// This fork imports upstream's Windows runtime and tests, not its binary publishing pipeline.
// Pin the fork boundary here instead of requiring upstream's payload and release jobs.
interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, string>;
}

interface Job {
  readonly permissions?: Record<string, string>;
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

function workflow(name: string): Workflow {
  const text = readFileSync(join(import.meta.dir, "..", ".github", "workflows", name), "utf8");
  // SAFETY: every consumed YAML field is compared against a literal below.
  return Bun.YAML.parse(text) as Workflow;
}

describe("the fork's source-only release boundary", () => {
  const release = workflow("release.yml");

  test("only verifies manual publication, without binary build or publishing jobs", () => {
    expect(Object.keys(release.jobs)).toEqual(["verify"]);
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.verify?.permissions).toBeUndefined();
    expect(release.jobs.verify?.["runs-on"]).toBe("ubuntu-latest");
    expect(release.jobs.verify?.["timeout-minutes"]).toBe(15);
  });

  test("the verifier neither builds nor uploads payloads or notifies upstream's website", () => {
    const steps = release.jobs.verify?.steps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    const scripts = steps.map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain("bun .github/scripts/verify-release.ts");
    expect(scripts).not.toMatch(/gh release (create|upload|edit|delete)|build-windows-payload|windows-asset|bun run build|repository_dispatch/);
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
  });

  test("Windows validation remains a separate read-only suite, not a release dependency", () => {
    const windows = workflow("windows.yml");
    expect(Object.keys(windows.jobs)).toEqual(["windows"]);
    const job = windows.jobs.windows;
    expect(job?.["runs-on"]).toBe("windows-latest");
    expect(job?.permissions).toEqual({ contents: "read" });
    const scripts = (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(scripts).toContain("scripts\\windows-suites.ps1");
    expect(scripts).not.toMatch(/gh release (create|upload|edit|delete)|build-windows-payload/);
  });
});
