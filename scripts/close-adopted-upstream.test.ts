import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closingComment, decide, issueTag, parseIssues, TAG_NAMESPACE } from "../.github/scripts/close-adopted-upstream.ts";

const script = new URL("../.github/scripts/close-adopted-upstream.ts", import.meta.url).pathname;

test("only release issues name a tag", () => {
	expect(issueTag("Adopt upstream AltanS/collie v1.22.3")).toBe("v1.22.3");
	expect(issueTag("  Adopt upstream AltanS/collie v1.23.10 ")).toBe("v1.23.10");
	expect(issueTag("Upstream AltanS/collie:main is 564 commit(s) ahead")).toBeNull();
	expect(issueTag("Adopt upstream AltanS/collie v1.22.3 and more")).toBeNull();
	expect(issueTag("Adopt upstream someone/else v1.22.3")).toBeNull();
	expect(issueTag("Adopt upstream AltanS/collie v1.22")).toBeNull();
});

test("an issue closes only when its tag resolves and is in main", () => {
	const commits = new Map([["v1.0.0", "a".repeat(40)], ["v2.0.0", "b".repeat(40)]]);
	const inMain = new Set(["a".repeat(40)]);
	const decisions = decide(
		[
			{ number: 7, title: "Adopt upstream AltanS/collie v2.0.0" },
			{ number: 3, title: "Adopt upstream AltanS/collie v1.0.0" },
			{ number: 5, title: "Adopt upstream AltanS/collie v9.9.9" },
			{ number: 6, title: "Upstream AltanS/collie:main is 5 commit(s) ahead" },
		],
		(tag) => commits.get(tag) ?? null,
		(commit) => inMain.has(commit),
	);
	expect(decisions).toEqual([
		{ number: 3, tag: "v1.0.0", action: "close", tagCommit: "a".repeat(40) },
		{ number: 5, tag: "v9.9.9", action: "keep", reason: "tag not found" },
		{ number: 7, tag: "v2.0.0", action: "keep", reason: "not adopted" },
	]);
});

test("the issue list is validated", () => {
	expect(parseIssues([{ number: 1, title: "x", extra: true }])).toEqual([{ number: 1, title: "x" }]);
	expect(() => parseIssues({ number: 1 })).toThrow();
	expect(() => parseIssues([{ number: 0, title: "x" }])).toThrow();
	expect(() => parseIssues([{ number: 1 }])).toThrow();
});

test("the closing comment names the tag, both commits and the run", () => {
	const body = closingComment("v1.0.0", "a".repeat(40), "b".repeat(40), "https://example.test/run/1");
	expect(body).toContain("`v1.0.0` (`aaaaaaaa`) is an ancestor of `main` at `bbbbbbbb`");
	expect(body).toContain("(https://example.test/run/1)");
	expect(body).not.toContain("\u2014");
});

function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "collie upstream close-"));
	const repo = join(root, "repo");
	const bin = join(root, "bin");
	const log = join(root, "gh.log");
	Bun.spawnSync(["mkdir", "-p", repo, bin]);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "adopted");
	git(repo, "update-ref", `${TAG_NAMESPACE}v1.0.0`, "HEAD");
	const main = git(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "fork work");
	git(repo, "update-ref", "refs/heads/main", main);
	const side = git(repo, "commit-tree", "HEAD^{tree}", "-p", `${TAG_NAMESPACE}v1.0.0`, "-m", "newer upstream");
	git(repo, "update-ref", `${TAG_NAMESPACE}v1.1.0`, side);
	const issues = JSON.stringify([
		{ number: 12, title: "Adopt upstream AltanS/collie v1.1.0" },
		{ number: 10, title: "Adopt upstream AltanS/collie v1.0.0" },
		{ number: 11, title: "Adopt upstream AltanS/collie v9.0.0" },
		{ number: 13, title: "Upstream AltanS/collie:main is 3 commit(s) ahead" },
	]);
	writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${log}'\nif [[ "$1 $2" == "issue list" ]]; then printf '%s' '${issues}'; fi\n`);
	chmodSync(join(bin, "gh"), 0o755);
	return { root, repo, bin, log, main };
}

function runScript(env: Record<string, string>) {
	const f = fixture();
	const summary = join(f.root, "summary");
	writeFileSync(summary, "");
	writeFileSync(f.log, "");
	try {
		const result = Bun.spawnSync([process.execPath, script], {
			cwd: f.repo,
			env: {
				...process.env, PATH: `${f.bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "owner/fork", MAIN_SHA: f.main,
				GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "42", GITHUB_STEP_SUMMARY: summary, ...env,
			},
		});
		return { code: result.exitCode, stderr: result.stderr.toString(), gh: readFileSync(f.log, "utf8"), summary: readFileSync(summary, "utf8") };
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
}

test("end to end: closes only the adopted release and leaves the rest open", () => {
	const result = runScript({});
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	const calls = result.gh.split("\n").filter((line) => line.startsWith("issue "));
	expect(calls[0]).toBe("issue list --repo owner/fork --state open --label upstream-sync --limit 1000 --json number,title");
	expect(calls).toHaveLength(2);
	expect(calls[1]).toStartWith("issue close 10 --repo owner/fork --reason completed --comment Adopted. Upstream `v1.0.0`");
	expect(result.gh).toContain("https://github.com/owner/fork/actions/runs/42");
	expect(result.summary).toContain("- #10 `v1.0.0`: closed");
	expect(result.summary).toContain("- #11 `v9.0.0`: kept open, tag not found");
	expect(result.summary).toContain("- #12 `v1.1.0`: kept open, not adopted");
	expect(result.summary).not.toContain("#13");
});

test("end to end: a dry run closes nothing", () => {
	const result = runScript({ DRY_RUN: "true" });
	expect(result.code).toBe(0);
	expect(result.gh.split("\n").filter((line) => line.startsWith("issue "))).toEqual([expect.stringMatching(/^issue list /)]);
	expect(result.summary).toContain("(dry run)");
	expect(result.summary).toContain("- #10 `v1.0.0`: would close");
});

test("end to end: a short or missing main commit refuses to run", () => {
	expect(runScript({ MAIN_SHA: "abc123" }).code).not.toBe(0);
});
