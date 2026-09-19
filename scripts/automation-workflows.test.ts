import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { JsonValue } from "../bridge/json.ts";
import { jsonRecord, jsonStringField } from "../bridge/stt/json.ts";

function workflow(name: string): JsonValue {
	const yaml = Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
	// Normalize YAML to JSON for the repository's JSON field readers.
	return JSON.parse(JSON.stringify(yaml));
}

function runStep(name: string, job: string, step: string) {
	const jobs = jsonRecord(jsonRecord(workflow(name))?.jobs);
	const steps = jsonRecord(jobs?.[job])?.steps;
	assert(Array.isArray(steps));
	const found = steps.map(jsonRecord).find((entry) => entry?.name === step);
	const script = jsonStringField(found?.run);
	assert(script, `Missing ${name} step ${step}`);
	return script;
}

function shell(script: string, env: NodeJS.ProcessEnv = {}) {
	// Actions writes output and summaries to appendable files. FD 3 is a real pipe, unlike
	// Bun's captured stdout socket, so the workflow's append redirections work unchanged.
	const result = Bun.spawnSync(["bash", "-e", "-c", `exec 3> >(cat)\n${script}`], {
		env: { ...process.env, GITHUB_OUTPUT: "/dev/fd/3", GITHUB_STEP_SUMMARY: "/dev/fd/3", ...env },
	});
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("release verification has no publishing permission and can retry an explicit tag", () => {
	expect(workflow("release")).toMatchObject({
		permissions: { contents: "read" },
		on: { workflow_dispatch: { inputs: { tag: { required: true, type: "string" } } } },
		jobs: { verify: { steps: expect.arrayContaining([
			{ uses: "actions/checkout@v4", with: { "persist-credentials": false } },
			{ uses: "actions/checkout@v4", with: { ref: "${{ steps.tag.outputs.oid }}", path: "release-source", "persist-credentials": false } },
		]) } },
	});
	const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	expect(source).not.toMatch(/gh release (create|upload|edit|delete)|contents: write/);
});

test("published notes are checked against the pinned release changelog", () => {
	const script = runStep("release", "verify", "Verify manual publication (wait up to ten minutes)");
	const result = shell(`bun() { printf '%s\\n' "$@"; }\n${script}`, {
		TAG: "v1.10.1+ys.1", RUNNER_TEMP: "/tmp/release-test",
	});
	expect(result.code).toBe(0);
	expect(result.stdout.trim().split("\n")).toEqual([
		".github/scripts/verify-release.ts", "v1.10.1+ys.1", "/tmp/release-test/expected-release.json", "release-source/CHANGELOG.md",
	]);
});

test("triage explicitly selects manual triage without weakening configured failures", () => {
	expect(workflow("triage")).toMatchObject({
		jobs: {
			classify: {
				steps: expect.arrayContaining([
					{ uses: "actions/checkout@v7" },
					expect.objectContaining({ id: "key", env: { OPENROUTER_API_KEY: "${{ secrets.OPENROUTER_API_KEY }}" } }),
					expect.objectContaining({ name: "Classify and label", if: "steps.key.outputs.configured == 'true'", run: "node .github/scripts/triage.mjs" }),
					expect.objectContaining({ name: "Fall back to manual triage", if: "failure() || steps.key.outputs.configured == 'false'" }),
				]),
			},
		},
	});
	const source = readFileSync(new URL("../.github/workflows/triage.yml", import.meta.url), "utf8");
	expect(source).not.toMatch(/^\s*continue-on-error:/m);
	expect(source).not.toMatch(/^\s*ref:/m);
	expect(source).toContain("GITHUB_STEP_SUMMARY");
});

test("key detection reports only presence, never the secret", () => {
	const script = runStep("triage", "classify", "Check classifier configuration");
	for (const [key, configured] of [["", "false"], ["secret-test-value", "true"]]) {
		const result = shell(script, { OPENROUTER_API_KEY: key });
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`configured=${configured}\n`);
		expect(result.stderr).toBe("");
	}
});

test("manual triage labels and explains the absent-key path", () => {
	const script = runStep("triage", "classify", "Fall back to manual triage");
	const result = shell(`gh() { printf '%s\\n' "$*"; }\n${script}`, {
		NUMBER: "12", CONFIGURED: "false", GITHUB_REPOSITORY: "owner/repo",
	});
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("repos/owner/repo/issues/12/labels -X POST -f labels[]=needs triage");
	expect(result.stdout).toContain("classifier was not run");
	expect(result.stdout).toContain("apply labels manually");
	expect(result.stdout).toContain("dispatch Triage");
});

test("manual labeling API failure stays red", () => {
	const script = runStep("triage", "classify", "Fall back to manual triage");
	const result = shell(`gh() { return 22; }\n${script}`, {
		NUMBER: "12", CONFIGURED: "false", GITHUB_REPOSITORY: "owner/repo",
	});
	expect(result.code).toBe(22);
	expect(result.stdout).not.toContain("Added");
});

test("tag pinning only accepts canonical existing fork tags", () => {
	const script = runStep("release", "verify", "Pin the existing tag");
	const fakeGitHub = 'gh() { echo \'{"object":{"sha":"0123456789012345678901234567890123456789"}}\'; }';
	for (const tag of ["v1.10.1+ys.1", "v0.0.0+ys.42"]) {
		const result = shell(`${fakeGitHub}\n${script}`, { TAG: tag, FORCED: "false", DELETED: "false", GITHUB_REPOSITORY: "owner/repo" });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`tag=${tag}`);
	}
	for (const tag of ["dev-joe", "v1.10.1", "v01.10.1+ys.1", "v1.10.1+ys.0", "v1.10.1+ys.1\ninjected=true", "$(exit 0)"]) {
		expect(shell(script, { TAG: tag, FORCED: "false", DELETED: "false" }).code).not.toBe(0);
	}
	for (const env of [{ FORCED: "true", DELETED: "false" }, { FORCED: "false", DELETED: "true" }]) {
		expect(shell(script, { TAG: "v1.10.1+ys.1", ...env }).code).not.toBe(0);
	}
});

test("a missing tag or failed lookup cannot become a new release", () => {
	const script = runStep("release", "verify", "Pin the existing tag");
	for (const fakeGitHub of ["gh() { return 1; }", "gh() { echo '{}'; }"]) {
		const result = shell(`${fakeGitHub}\n${script}`, {
			TAG: "v1.10.1+ys.1", FORCED: "false", DELETED: "false", GITHUB_REPOSITORY: "owner/repo",
		});
		expect(result.code).not.toBe(0);
		expect(result.stdout).not.toContain("oid=");
	}
});

test("tag movement is rejected instead of recreating the tag", () => {
	const script = runStep("release", "verify", "Ensure the tag has not moved");
	const result = shell(`gh() { echo '{"object":{"sha":"different"}}'; }\n${script}`, {
		TAG: "v1.10.1+ys.1", EXPECTED_OID: "original", GITHUB_REPOSITORY: "owner/repo",
	});
	expect(result.code).not.toBe(0);
	expect(result.stderr).toContain("tag moved");
});
