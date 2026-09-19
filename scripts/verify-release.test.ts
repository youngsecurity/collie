import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRelease } from "../.github/scripts/verify-release.ts";
import type { JsonValue } from "../bridge/json.ts";

const tag = "v1.10.1+ys.1";
const expected = { version: "1.10.1+ys.1", crewProtocol: 2 };
const repository = "youngsecurity/collie";
const reason = "Updating can leave the service stopped.";
const changelog = `## [1.10.1+ys.1] - 2026-09-16

### Fixed

- **A fix.** The details.
- **Another fix.** More details.
`;
const urgentChangelog = changelog.replace("\n\n###", `\n\n**Urgent.** ${reason}\n\n###`);
const body = `## Update

herdr plugin action invoke update --plugin herdr.collie
herdr plugin action invoke restart --plugin herdr.collie

## What changed

**Fixed**

- A fix.
- Another fix.

Full detail with commits: [1.10.1+ys.1 in the changelog](https://github.com/youngsecurity/collie/blob/v1.10.1+ys.1/CHANGELOG.md#1101ys1---2026-09-16)
`;
const urgentBody = `**Urgent.** ${reason}\n\n${body}`;
const published = {
	tag_name: tag, draft: false, body,
	assets: [{ id: 42, name: "collie-release.json", state: "uploaded" }],
};

test("verifies the published sidecar semantically after a tag-before-publication wait", async () => {
	let waits = 0;
	const paths: string[] = [];
	await verifyRelease({
		tag, expected, changelog, repository, attempts: 2,
		pause: async () => { waits++; },
		request: async (path, accept) => {
			paths.push(path);
			if (paths.length === 1) return new Response(null, { status: 404 });
			if (path.includes("/assets/")) {
				expect(accept).toBe("application/octet-stream");
				return Response.json({ crewProtocol: 2, version: "1.10.1+ys.1" });
			}
			return Response.json(published);
		},
	});
	expect(waits).toBe(1);
	expect(paths).toEqual([`/releases/tags/${encodeURIComponent(tag)}`, `/releases/tags/${encodeURIComponent(tag)}`, "/releases/assets/42"]);
});

function verify(metadata: JsonValue = published, sidecar: JsonValue = expected, generated: JsonValue = expected, source = changelog) {
	return verifyRelease({
		tag, expected: generated, changelog: source, repository, attempts: 1,
		request: async (path) => Response.json(path.includes("/assets/") ? sidecar : metadata),
	});
}

test.each([
	["wrong version", { ...expected, version: "1.10.0+ys.1" }],
	["wrong protocol", { ...expected, crewProtocol: 1 }],
	["extra field", { ...expected, extra: true }],
	["spurious urgency", { ...expected, urgent: { reason: "Updating can leave the service stopped." } }],
	["missing protocol", { version: expected.version }],
])("refuses a sidecar with %s", async (_name, sidecar) => {
	await expect(verify(published, sidecar)).rejects.toThrow("differs from tagged source");
});

test.each([
	["copied version", body.replaceAll("1.10.1+ys.1", "1.10.0+ys.1")],
	["missing lead", body.replace("- Another fix.\n", "")],
	["wrong lead", body.replace("- A fix.", "- An old fix.")],
	["wrong group", body.replace("**Fixed**", "**Added**")],
	["wrong changelog anchor", body.replace("1101ys1---2026-09-16", "1100ys1---2026-09-15")],
	["spurious urgency", urgentBody],
	["misplaced urgency", body.replace("## What changed", `**Urgent.** ${reason}\n\n## What changed`)],
])("refuses notes with %s", async (_name, notes) => {
	await expect(verify({ ...published, body: notes })).rejects.toThrow();
});

test.each([
	["missing marker", body],
	["wrong reason", urgentBody.replace(reason, "A paired device stays paired after you revoke it.")],
	["duplicate marker", `**Urgent.** ${reason}\n${urgentBody}`],
])("urgent notes refuse %s", async (_name, notes) => {
	const urgent = { ...expected, urgent: { reason } };
	await expect(verify({ ...published, body: notes }, urgent, urgent, urgentChangelog)).rejects.toThrow();
});

const previousTag = "v1.10.0+ys.1";
const compare = `Compare: [${previousTag}...${tag}](https://github.com/${repository}/compare/${previousTag}...${tag})`;

test("an optional Compare link names a real tag and the current release", async () => {
	const paths: string[] = [];
	await verifyRelease({
		tag, expected, changelog, repository,
		request: async (path) => {
			paths.push(path);
			if (path.startsWith("/git/ref/")) return Response.json({ ref: `refs/tags/${previousTag}` });
			return Response.json(path.includes("/assets/") ? expected : { ...published, body: `${body}\n${compare}\n` });
		},
	});
	expect(paths).toContain(`/git/ref/tags/${encodeURIComponent(previousTag)}`);
});

test.each([
	["nonexistent tag", compare, 404],
	["wrong repository", compare.replace(`/compare/`, "-other/compare/"), 200],
	["wrong destination", compare.replaceAll(`...${tag}`, `...${previousTag}`), 200],
	["self comparison", compare.replaceAll(previousTag, tag), 200],
	["duplicate link", `${compare}\n${compare}`, 200],
])("refuses Compare with %s", async (_name, link, status) => {
	await expect(verifyRelease({
		tag, expected, changelog, repository,
		request: async (path) => {
			if (path.startsWith("/git/ref/")) return Response.json({ ref: `refs/tags/${previousTag}` }, { status });
			return Response.json(path.includes("/assets/") ? expected : { ...published, body: `${body}\n${link}\n` });
		},
	})).rejects.toThrow();
});

test("a manually edited fork Update block stays allowed", async () => {
	const notes = body.replace("## Update", "## Update\n\nHerdr ≥ 0.8.0 is required. Stay in the +ys family.\n\nSee [this fork](https://github.com/youngsecurity/collie/blob/main/docs/install.md#this-fork).");
	await expect(verify({ ...published, body: notes })).resolves.toBeUndefined();
});

test("CLI requires the tagged changelog path instead of falling back to the working tree", () => {
	const result = Bun.spawnSync([process.execPath, ".github/scripts/verify-release.ts", tag, "expected.json"]);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain("TAGGED_CHANGELOG");
});

test.each([false, true])("CLI reports urgency to stdout and the job summary: %s", async (urgent) => {
	const directory = mkdtempSync(join(tmpdir(), "collie-verifier-"));
	const expectedPath = join(directory, "expected.json");
	const changelogPath = join(directory, "CHANGELOG.md");
	const preload = join(directory, "fetch.ts");
	const summary = join(directory, "summary.md");
	const sidecar = urgent ? { ...expected, urgent: { reason } } : expected;
	const metadata = { ...published, body: urgent ? urgentBody : body };
	writeFileSync(expectedPath, JSON.stringify(sidecar));
	writeFileSync(changelogPath, urgent ? urgentChangelog : changelog);
	// Exercise the actual CLI without any GitHub access or mutations.
	writeFileSync(preload, `globalThis.fetch = async (url, init) => {
		if (init?.method && init.method !== "GET") throw new Error("Not read-only");
		return Response.json(String(url).includes("/assets/") ? ${JSON.stringify(sidecar)} : ${JSON.stringify(metadata)});
	};`);
	const child = Bun.spawn([process.execPath, "--preload", preload, ".github/scripts/verify-release.ts", tag, expectedPath, changelogPath], {
		env: { ...process.env, GITHUB_REPOSITORY: repository, GH_TOKEN: "test-only", GITHUB_STEP_SUMMARY: summary },
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout.split("\n")).toContain(urgent ? `urgent: ${reason}` : "urgent: none, ordinary release");
	expect(readFileSync(summary, "utf8")).toBe(stdout);
});

test("valid notes tolerate CRLF line endings", async () => {
	await expect(verify({ ...published, body: body.replaceAll("\n", "\r\n") })).resolves.toBeUndefined();
});

test("urgency must also match generated content", async () => {
	const urgent = { ...expected, urgent: { reason: "Updating can leave the service stopped." } };
	const metadata = { ...published, body: urgentBody };
	await expect(verify(metadata, expected, urgent, urgentChangelog)).rejects.toThrow("differs from tagged source");
	await expect(verify(metadata, urgent, urgent, urgentChangelog)).resolves.toBeUndefined();
});

test.each([
	["a draft", { ...published, draft: true }],
	["an absent sidecar", { ...published, assets: [] }],
	["an unfinished upload", { ...published, assets: [{ id: 42, name: "collie-release.json", state: "new" }] }],
])("bounded wait refuses %s and explains manual retry", async (_name, metadata) => {
	await expect(verify(metadata)).rejects.toThrow("Publish manually, then dispatch Verify release");
});

test("publication can finish after a draft or an unfinished sidecar", async () => {
	const pending = [
		{ ...published, draft: true },
		{ ...published, assets: [] },
		published,
	];
	let waits = 0;
	await verifyRelease({
		tag, expected, changelog, repository, attempts: 3,
		pause: async () => { waits++; },
		request: async (path) => Response.json(path.includes("/assets/") ? expected : pending.shift()),
	});
	expect(waits).toBe(2);
});

test("404 publication timeout uses exactly the bounded wait", async () => {
	let waits = 0;
	await expect(verifyRelease({
		tag, expected, changelog, repository, attempts: 3,
		pause: async () => { waits++; },
		request: async () => new Response(null, { status: 404 }),
	})).rejects.toThrow("after 3 checks");
	expect(waits).toBe(2);
});

test.each([401, 403, 429, 500])("HTTP %s fails immediately, not as missing publication", async (status) => {
	let waits = 0;
	await expect(verifyRelease({
		tag, expected, changelog, repository,
		pause: async () => { waits++; },
		request: async () => new Response(null, { status }),
	})).rejects.toThrow(`HTTP ${status}`);
	expect(waits).toBe(0);
});

const invalidMetadata: JsonValue[] = [
	{ ...published, tag_name: "v1.10.0+ys.1" },
	{ ...published, body: "## What changed\n\n## Update\n" },
	{ ...published, body: body.replace("invoke restart", "invoke status") },
	{ ...published, body: `${body}\n<details>Verify a download</details>` },
	{ ...published, assets: [...published.assets, { id: 43, name: "binary.tar.gz", state: "uploaded" }] },
	{ ...published, assets: [...published.assets, ...published.assets] },
	{ ...published, draft: "false" },
	null,
];

test.each(invalidMetadata)("refuses invalid metadata or non-source-only publication: %j", async (metadata) => {
	await expect(verify(metadata)).rejects.toThrow();
});

test("a generated version mismatch fails before accessing GitHub", async () => {
	let requests = 0;
	await expect(verifyRelease({
		tag, expected: { ...expected, version: "1.10.0+ys.1" }, changelog, repository,
		request: async () => { requests++; return Response.json(published); },
	})).rejects.toThrow("Generated sidecar and tag disagree");
	expect(requests).toBe(0);
});

test("malformed downloaded JSON and download failures remain red", async () => {
	for (const response of [new Response("not JSON"), new Response(null, { status: 403 })]) {
		await expect(verifyRelease({
			tag, expected, changelog, repository,
			request: async (path) => path.includes("/assets/") ? response : Response.json(published),
		})).rejects.toThrow();
	}
});
