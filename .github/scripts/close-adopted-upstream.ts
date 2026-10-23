// Close the upstream-watch issues that `main` has already adopted.
//
// The upstream watcher opens one `Adopt upstream AltanS/collie vX.Y.Z` issue per upstream release.
// One adoption merge usually covers several of them: adopting v1.22.5 also brings v1.22.0..v1.22.3.
// Closing them by hand was forgotten, so this runs on every push to `main` instead. An issue is
// closed only when its upstream tag is an ancestor of the pushed `main` commit. Anything else,
// including a tag that cannot be found, stays open.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import type { JsonValue } from "../../bridge/json.ts";
import { jsonNumberField, jsonRecord, jsonStringField } from "../../bridge/stt/json.ts";

export const UPSTREAM = "AltanS/collie";
export const LABEL = "upstream-sync";
/** Where the workflow fetches upstream's tags, so they never mix with the fork's `+ys` tags. */
export const TAG_NAMESPACE = "refs/tags/upstream/";

const TITLE = /^Adopt upstream AltanS\/collie (v\d+\.\d+\.\d+)$/;

export type Issue = { number: number; title: string };
export type Decision =
	| { number: number; tag: string; action: "close"; tagCommit: string }
	| { number: number; tag: string; action: "keep"; reason: "not adopted" | "tag not found" };

/** The release tag an issue asks to adopt, or null for any other `upstream-sync` issue. */
export function issueTag(title: string): string | null {
	return TITLE.exec(title.trim())?.[1] ?? null;
}

/**
 * Decide each release issue. `resolve` returns the tag's commit or null when the tag is missing;
 * `isAncestor` answers whether that commit is in `main`. Issues that name no release are skipped.
 */
export function decide(issues: Issue[], resolve: (tag: string) => string | null, isAncestor: (commit: string) => boolean): Decision[] {
	const decisions: Decision[] = [];
	for (const issue of issues.toSorted((a, b) => a.number - b.number)) {
		const tag = issueTag(issue.title);
		if (!tag) continue;
		const tagCommit = resolve(tag);
		if (!tagCommit) decisions.push({ number: issue.number, tag, action: "keep", reason: "tag not found" });
		else if (isAncestor(tagCommit)) decisions.push({ number: issue.number, tag, action: "close", tagCommit });
		else decisions.push({ number: issue.number, tag, action: "keep", reason: "not adopted" });
	}
	return decisions;
}

/** The comment left on an issue as it closes. */
export function closingComment(tag: string, tagCommit: string, mainCommit: string, runUrl: string): string {
	return [
		`Adopted. Upstream \`${tag}\` (\`${tagCommit.slice(0, 8)}\`) is an ancestor of \`main\` at \`${mainCommit.slice(0, 8)}\`.`,
		"",
		`Closed automatically by the [Close adopted upstream issues](${runUrl}) workflow, which checks every open \`${LABEL}\` release issue on each push to \`main\`.`,
	].join("\n");
}

export function parseIssues(value: JsonValue): Issue[] {
	assert(Array.isArray(value), "Expected an issue list");
	return value.map((entry) => {
		const record = jsonRecord(entry);
		const number = jsonNumberField(record?.number);
		const title = jsonStringField(record?.title);
		assert(number !== null && Number.isSafeInteger(number) && number > 0 && title !== null, "Invalid issue");
		return { number, title };
	});
}

function run(cmd: string[]) {
	const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "inherit" });
	return { code: result.exitCode, out: result.stdout.toString().trim() };
}

function must(cmd: string[]): string {
	const result = run(cmd);
	assert(result.code === 0, `${cmd.join(" ")} exited ${result.code}`);
	return result.out;
}

if (import.meta.main) {
	const repo = process.env.GITHUB_REPOSITORY;
	const mainCommit = process.env.MAIN_SHA;
	const dryRun = process.env.DRY_RUN === "true";
	const runUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
	assert(repo && mainCommit && /^[0-9a-f]{40}$/.test(mainCommit), "GITHUB_REPOSITORY and a full MAIN_SHA are required");

	const issues = parseIssues(JSON.parse(must([
		"gh", "issue", "list", "--repo", repo, "--state", "open", "--label", LABEL, "--limit", "1000", "--json", "number,title",
	])));
	const decisions = decide(
		issues,
		(tag) => {
			const result = run(["git", "rev-parse", "--verify", "--quiet", `${TAG_NAMESPACE}${tag}^{commit}`]);
			return result.code === 0 && result.out ? result.out : null;
		},
		(commit) => {
			const { code } = run(["git", "merge-base", "--is-ancestor", commit, mainCommit]);
			assert(code === 0 || code === 1, `git merge-base exited ${code}`);
			return code === 0;
		},
	);

	const lines = [`### Upstream release issues at \`${mainCommit.slice(0, 8)}\`${dryRun ? " (dry run)" : ""}`, ""];
	if (decisions.length === 0) lines.push("No open release issues.");
	for (const decision of decisions) {
		if (decision.action === "close") {
			if (!dryRun) {
				must(["gh", "issue", "close", String(decision.number), "--repo", repo, "--reason", "completed",
					"--comment", closingComment(decision.tag, decision.tagCommit, mainCommit, runUrl)]);
			}
			lines.push(`- #${decision.number} \`${decision.tag}\`: ${dryRun ? "would close" : "closed"}`);
		} else {
			lines.push(`- #${decision.number} \`${decision.tag}\`: kept open, ${decision.reason}`);
			if (decision.reason === "tag not found") console.log(`::warning::#${decision.number}: upstream tag ${decision.tag} not found`);
		}
	}
	const summary = lines.join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
